import { createDatabase, warmUpConnections } from '@ai-measurement/infra';
import { buildCandidateApp } from './candidate-app';
import { buildCandidateServices, STREAM_HUB_TIMING } from './candidate-services';
import { loadCandidateServerConfig } from './config/candidate-server-config';
import { createAiGateway } from './create-ai-gateway';
import { loadConfigOrExit, requireDirectoryOrExit, serveUntilSignal } from './http/server-process';
import { MS_PER_SECOND, systemClock } from './lib/clock';
import { consoleLogger } from './lib/logger';

/**
 * 수험생 서버 진입점. DB 역할 aim_candidate_server로 접속한다.
 * 마이그레이션과 DB 로그인 계정은 scripts/migrate-database.ts, scripts/apply-database-logins.ts로 먼저 만든다.
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit(() => loadCandidateServerConfig(process.env));
  await requireDirectoryOrExit(config.examsDir, 'EXAMS_DIR');

  const database = createDatabase(config.database, { maxConnections: config.databaseMaxConnections });
  await warmUpConnections(database, config.databaseMaxConnections);
  const ai = createAiGateway(config);
  const services = buildCandidateServices({ database, streamTiming: STREAM_HUB_TIMING, config, clock: systemClock, ai, logger: consoleLogger });
  // 다른 수험생 서버의 스냅숏 요청을 받을 준비가 된 뒤에 요청을 받는다
  await services.hub.start();

  // 여러 대가 함께 돌아도 결과가 같다: 세션 종료는 행을 잠근 뒤 상태를 다시 확인하고, 기록 정리는 멱등이다
  const sweeper = setInterval(() => {
    services.sessions
      .sweepExpired()
      .then((count) => {
        if (count > 0) consoleLogger.info('sessions_expired', { count });
      })
      .catch((error: unknown) => consoleLogger.error('session_sweep_failed', { error }));
    services.attempts
      .prune(new Date(systemClock.now().getTime() - services.attemptRetentionMs))
      .catch((error: unknown) => consoleLogger.error('attempt_prune_failed', { error }));
  }, config.sessionSweepSeconds * MS_PER_SECOND);

  serveUntilSignal({
    name: 'candidate_server',
    app: buildCandidateApp(services),
    listen: config.listen,
    logger: consoleLogger,
    startInfo: { aiProvider: ai.provider, instanceId: services.hub.instanceId },
    onShutdown: async () => {
      clearInterval(sweeper);
      await services.hub.stop();
      await database.close();
    },
  });
}

await main();
