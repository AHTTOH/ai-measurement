import path from 'node:path';
import { databaseConnectionFromEnv, type DatabaseConnection } from '@ai-measurement/infra';
import { z } from 'zod';

/**
 * 채점 워커 환경변수. 모두 필수이며 코드 쪽 기본값이 없다(폴백 금지). 뜻은 infra/.env.example 참고.
 * DB는 채점 워커 역할(aim_grading_worker)로 접속한다. 루브릭·정답을 읽을 수 있는 유일한 역할이다.
 */
const workerEnvSchema = z
  .object({
    GRADING_WORKER_DB_MAX_CONNECTIONS: z.coerce.number().int().min(1),
    EXAMS_DIR: z.string().min(1),
    GRADING_LLM_PROVIDER: z.enum(['anthropic', 'mock']),
    ANTHROPIC_API_KEY: z.string().optional(),
    GRADING_POLL_SECONDS: z.coerce.number().int().min(1),
    GRADING_BATCH_POLL_SECONDS: z.coerce.number().int().min(1),
    GRADING_DIRECT_CONCURRENCY: z.coerce.number().int().min(1).max(32),
    GRADING_JOB_LOCK_MINUTES: z.coerce.number().int().min(1),
    /** 있으면 이 포트로 상태 확인 HTTP를 연다. Cloud Run 서비스는 포트를 열어야 뜬다(2026-09-27 배포). 로컬은 두지 않는다 */
    GRADING_WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.GRADING_LLM_PROVIDER === 'anthropic' && (env.ANTHROPIC_API_KEY ?? '').trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'GRADING_LLM_PROVIDER=anthropic이면 필수입니다' });
    }
  });

export interface WorkerConfig {
  database: DatabaseConnection;
  databaseMaxConnections: number;
  examsDir: string;
  provider: 'anthropic' | 'mock';
  anthropicApiKey: string | null;
  pollSeconds: number;
  batchPollSeconds: number;
  directConcurrency: number;
  jobLockMinutes: number;
  /** 상태 확인 HTTP 포트. null이면 열지 않는다 */
  healthPort: number | null;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new Error(`채점 워커 환경변수가 올바르지 않습니다. infra/.env.example을 참고하십시오.\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    database: databaseConnectionFromEnv(env, 'GRADING_WORKER_DB_USER', 'GRADING_WORKER_DB_PASSWORD'),
    databaseMaxConnections: e.GRADING_WORKER_DB_MAX_CONNECTIONS,
    examsDir: path.resolve(e.EXAMS_DIR),
    provider: e.GRADING_LLM_PROVIDER,
    anthropicApiKey: e.ANTHROPIC_API_KEY?.trim() ? e.ANTHROPIC_API_KEY.trim() : null,
    pollSeconds: e.GRADING_POLL_SECONDS,
    batchPollSeconds: e.GRADING_BATCH_POLL_SECONDS,
    directConcurrency: e.GRADING_DIRECT_CONCURRENCY,
    jobLockMinutes: e.GRADING_JOB_LOCK_MINUTES,
    healthPort: e.GRADING_WORKER_HEALTH_PORT ?? null,
  };
}
