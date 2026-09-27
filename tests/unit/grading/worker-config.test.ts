import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '@ai-measurement/grading';
import { DatabaseConnectionConfigError } from '@ai-measurement/infra';
import { databaseEnv, without } from '../server/env-fixtures';

function workerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...databaseEnv('GRADING_WORKER_DB_USER', 'GRADING_WORKER_DB_PASSWORD'),
    GRADING_WORKER_DB_MAX_CONNECTIONS: '8',
    EXAMS_DIR: './exams',
    GRADING_LLM_PROVIDER: 'mock',
    GRADING_POLL_SECONDS: '5',
    GRADING_BATCH_POLL_SECONDS: '60',
    GRADING_DIRECT_CONCURRENCY: '4',
    GRADING_JOB_LOCK_MINUTES: '30',
    ...overrides,
  };
}

const WORKER_ENV_ERROR = /채점 워커 환경변수가 올바르지 않습니다/u;

describe('채점 워커 설정', () => {
  it('모의 채점 설정을 모두 변환한다', () => {
    // Arrange
    const env = workerEnv();

    // Act
    const config = loadWorkerConfig(env);

    // Assert
    expect(config).toEqual({
      database: { host: '127.0.0.1', port: 55432, database: 'ai_measurement', user: 'grading_worker_db_user_login', password: 'password-for-unit-tests-0001', ssl: 'disable' },
      databaseMaxConnections: 8,
      examsDir: path.resolve('./exams'),
      provider: 'mock',
      anthropicApiKey: null,
      pollSeconds: 5,
      batchPollSeconds: 60,
      directConcurrency: 4,
      jobLockMinutes: 30,
      healthPort: null,
    });
  });

  it('Anthropic 채점이면 키 앞뒤 공백을 지운다', () => {
    const config = loadWorkerConfig(workerEnv({ GRADING_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  sk-ant-grader  ' }));

    expect(config.provider).toBe('anthropic');
    expect(config.anthropicApiKey).toBe('sk-ant-grader');
  });

  it('모의 채점에서 키가 공백뿐이면 키 없음(null)으로 본다', () => {
    expect(loadWorkerConfig(workerEnv({ ANTHROPIC_API_KEY: '   ' })).anthropicApiKey).toBeNull();
  });

  it('Anthropic 채점인데 키가 없거나 공백뿐이면 거부한다', () => {
    const missing = () => loadWorkerConfig(workerEnv({ GRADING_LLM_PROVIDER: 'anthropic' }));
    const blank = () => loadWorkerConfig(workerEnv({ GRADING_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: ' ' }));

    expect(missing).toThrow(/ANTHROPIC_API_KEY: GRADING_LLM_PROVIDER=anthropic이면 필수입니다/u);
    expect(blank).toThrow(/ANTHROPIC_API_KEY: GRADING_LLM_PROVIDER=anthropic이면 필수입니다/u);
  });

  it.each([
    'GRADING_WORKER_DB_MAX_CONNECTIONS',
    'EXAMS_DIR',
    'GRADING_LLM_PROVIDER',
    'GRADING_POLL_SECONDS',
    'GRADING_BATCH_POLL_SECONDS',
    'GRADING_DIRECT_CONCURRENCY',
    'GRADING_JOB_LOCK_MINUTES',
  ])('%s가 없으면 그 이름을 적은 오류를 던진다', (variable) => {
    const load = () => loadWorkerConfig(without(workerEnv(), variable));

    expect(load).toThrow(WORKER_ENV_ERROR);
    expect(load).toThrow(variable);
  });

  it.each([
    ['GRADING_DIRECT_CONCURRENCY', '0'],
    ['GRADING_DIRECT_CONCURRENCY', '33'],
    ['GRADING_LLM_PROVIDER', 'openai'],
    ['GRADING_POLL_SECONDS', '0.5'],
    ['GRADING_JOB_LOCK_MINUTES', '0'],
    ['EXAMS_DIR', ''],
  ])('%s=%j는 거부한다', (variable, value) => {
    const load = () => loadWorkerConfig(workerEnv({ [variable]: value }));

    expect(load).toThrow(WORKER_ENV_ERROR);
    expect(load).toThrow(variable);
  });

  it('동시 요청 수는 32까지 받는다', () => {
    expect(loadWorkerConfig(workerEnv({ GRADING_DIRECT_CONCURRENCY: '32' })).directConcurrency).toBe(32);
  });

  it('채점 워커 계정이 없으면 DB 접속 오류를 던진다', () => {
    const load = () => loadWorkerConfig(without(workerEnv(), 'GRADING_WORKER_DB_PASSWORD'));

    expect(load).toThrow(DatabaseConnectionConfigError);
    expect(load).toThrow('GRADING_WORKER_DB_PASSWORD');
  });
});
