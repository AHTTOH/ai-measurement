import { createServer } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { consoleLogger, createDatabase } from '@ai-measurement/infra';
import { loadWorkerConfig, type WorkerConfig } from './config/worker-config';
import { GradingJobRunner } from './job/grading-job-runner';
import { AnthropicGrader } from './llm/anthropic-grader';
import type { LlmGrader } from './llm/llm-grader';
import { MockGrader } from './llm/mock-grader';

function createGrader(config: WorkerConfig): LlmGrader {
  if (config.provider === 'mock') return new MockGrader();
  if (config.anthropicApiKey === null) throw new Error('ANTHROPIC_API_KEY가 없습니다');
  return new AnthropicGrader(new Anthropic({ apiKey: config.anthropicApiKey }));
}

/** 채점 워커 진입점. 큐의 채점 작업을 하나씩 처리하고, 없으면 잠시 쉰다 */
async function main(): Promise<void> {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(process.env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
  const database = createDatabase(config.database, { maxConnections: config.databaseMaxConnections });
  const runner = new GradingJobRunner({
    db: database.db,
    examsDir: config.examsDir,
    grader: createGrader(config),
    logger: consoleLogger,
    now: () => new Date(),
    directConcurrency: config.directConcurrency,
    jobLockMinutes: config.jobLockMinutes,
    batchPollSeconds: config.batchPollSeconds,
  });

  let stopping = false;
  const stop = (signal: string) => {
    consoleLogger.info('grading_worker_stopping', { signal });
    stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // Cloud Run 서비스로 돌 때만 상태 확인 포트를 연다. 채점 루프가 도는 동안 200을 준다
  const health =
    config.healthPort === null
      ? null
      : createServer((_request, response) => {
          response.writeHead(stopping ? 503 : 200, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(stopping ? 'stopping' : 'ok');
        }).listen(config.healthPort);
  consoleLogger.info('grading_worker_started', { provider: config.provider, healthPort: config.healthPort });

  while (!stopping) {
    let worked = false;
    try {
      worked = await runner.runOnce();
    } catch (error) {
      consoleLogger.error('grading_worker_loop_failed', { error });
    }
    if (!worked) await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000));
  }
  health?.close();
  await database.close();
}

await main();
