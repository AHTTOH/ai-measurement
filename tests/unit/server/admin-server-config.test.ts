import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseConnectionConfigError } from '@ai-measurement/infra';
import { ConfigError, loadAdminServerConfig } from '@ai-measurement/server';
import { databaseEnv, LOGIN_POLICY_ENV, without } from './env-fixtures';

const BYTES_PER_MB = 1024 * 1024;

function adminEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...databaseEnv('ADMIN_SERVER_DB_USER', 'ADMIN_SERVER_DB_PASSWORD'),
    ...LOGIN_POLICY_ENV,
    ADMIN_SERVER_HOST: '127.0.0.1',
    ADMIN_SERVER_PORT: '3001',
    ADMIN_SESSION_COOKIE: 'aim_admin',
    ADMIN_SERVER_DB_MAX_CONNECTIONS: '5',
    EXAMS_DIR: './exams',
    GRADING_LLM_PROVIDER: 'mock',
    UPLOAD_MAX_MB: '50',
    ...overrides,
  };
}

describe('관리자 서버 설정', () => {
  it('정상 값을 모두 변환하고 업로드 한도를 바이트로 바꾼다', () => {
    // Arrange
    const env = adminEnv();

    // Act
    const config = loadAdminServerConfig(env);

    // Assert
    expect(config).toEqual({
      database: { host: '127.0.0.1', port: 55432, database: 'ai_measurement', user: 'admin_server_db_user_login', password: 'password-for-unit-tests-0001', ssl: 'disable' },
      databaseMaxConnections: 5,
      listen: { host: '127.0.0.1', port: 3001 },
      examsDir: path.resolve('./exams'),
      gradingLlmProvider: 'mock',
      uploadMaxBytes: 50 * BYTES_PER_MB,
      login: { cookieSecure: false, authSessionHours: 12, maxFailures: 5, lockMinutes: 15, attemptsPerIpPerMinute: 600 },
      sessionCookie: 'aim_admin',
      requestHostHeader: 'host',
      webDistDir: null,
    });
  });

  it('웹 빌드 폴더가 적혀 있으면 절대 경로로 바꾼다', () => {
    const config = loadAdminServerConfig(adminEnv({ ADMIN_WEB_DIST_DIR: './web/dist/admin' }));

    expect(config.webDistDir).toBe(path.resolve('./web/dist/admin'));
  });

  it('채점 공급자가 anthropic이어도 API 키를 요구하지 않는다(관리자 서버는 AI를 부르지 않는다)', () => {
    const config = loadAdminServerConfig(without(adminEnv({ GRADING_LLM_PROVIDER: 'anthropic' }), 'ANTHROPIC_API_KEY'));

    expect(config.gradingLlmProvider).toBe('anthropic');
  });

  it('업로드 한도는 1MB에서 500MB까지 받는다', () => {
    expect(loadAdminServerConfig(adminEnv({ UPLOAD_MAX_MB: '1' })).uploadMaxBytes).toBe(BYTES_PER_MB);
    expect(loadAdminServerConfig(adminEnv({ UPLOAD_MAX_MB: '500' })).uploadMaxBytes).toBe(500 * BYTES_PER_MB);
  });

  it.each(['ADMIN_SERVER_HOST', 'ADMIN_SERVER_PORT', 'ADMIN_SERVER_DB_MAX_CONNECTIONS', 'EXAMS_DIR', 'GRADING_LLM_PROVIDER', 'UPLOAD_MAX_MB', 'COOKIE_SECURE'])(
    '%s가 없으면 그 이름을 적은 ConfigError를 던진다',
    (variable) => {
      const load = () => loadAdminServerConfig(without(adminEnv(), variable));

      expect(load).toThrow(ConfigError);
      expect(load).toThrow(variable);
    },
  );

  it.each([
    ['UPLOAD_MAX_MB', '0'],
    ['UPLOAD_MAX_MB', '501'],
    ['GRADING_LLM_PROVIDER', 'openai'],
    ['ADMIN_SERVER_PORT', '70000'],
  ])('%s=%j는 거부한다', (variable, value) => {
    const load = () => loadAdminServerConfig(adminEnv({ [variable]: value }));

    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/관리자 서버 환경변수가 올바르지 않습니다/u);
  });

  it('수험생 서버의 DB 계정으로는 접속 설정을 만들지 않는다', () => {
    const env = {
      ...without(without(adminEnv(), 'ADMIN_SERVER_DB_USER'), 'ADMIN_SERVER_DB_PASSWORD'),
      ...databaseEnv('CANDIDATE_SERVER_DB_USER', 'CANDIDATE_SERVER_DB_PASSWORD'),
    };

    expect(() => loadAdminServerConfig(env)).toThrow(DatabaseConnectionConfigError);
  });
});
