import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseConnectionConfigError } from '@ai-measurement/infra';
import { ConfigError, loadCandidateServerConfig } from '@ai-measurement/server';
import { databaseEnv, LOGIN_POLICY_ENV, without } from './env-fixtures';

function candidateEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...databaseEnv('CANDIDATE_SERVER_DB_USER', 'CANDIDATE_SERVER_DB_PASSWORD'),
    ...LOGIN_POLICY_ENV,
    CANDIDATE_SERVER_HOST: '0.0.0.0',
    CANDIDATE_SERVER_PORT: '3000',
    CANDIDATE_SESSION_COOKIE: 'aim_candidate',
    CANDIDATE_SERVER_DB_MAX_CONNECTIONS: '20',
    EXAMS_DIR: './exams',
    AI_PROVIDER: 'mock',
    MOCK_AI_CHUNK_DELAY_MS: '40',
    CANDIDATE_AI_REQUESTS_PER_MINUTE: '20',
    SESSION_SWEEP_SECONDS: '15',
    ...overrides,
  };
}

const REQUIRED_VARIABLES = [
  'CANDIDATE_SERVER_HOST',
  'CANDIDATE_SERVER_PORT',
  'CANDIDATE_SERVER_DB_MAX_CONNECTIONS',
  'EXAMS_DIR',
  'AI_PROVIDER',
  'CANDIDATE_AI_REQUESTS_PER_MINUTE',
  'SESSION_SWEEP_SECONDS',
  'COOKIE_SECURE',
  'AUTH_SESSION_HOURS',
  'LOGIN_MAX_FAILURES',
  'LOGIN_LOCK_MINUTES',
  'LOGIN_ATTEMPTS_PER_IP_PER_MINUTE',
];

describe('수험생 서버 설정: 정상 값', () => {
  it('모의 AI 설정으로 모든 항목을 변환한다', () => {
    // Arrange
    const env = candidateEnv();

    // Act
    const config = loadCandidateServerConfig(env);

    // Assert
    expect(config).toEqual({
      database: { host: '127.0.0.1', port: 55432, database: 'ai_measurement', user: 'candidate_server_db_user_login', password: 'password-for-unit-tests-0001', ssl: 'disable' },
      databaseMaxConnections: 20,
      listen: { host: '0.0.0.0', port: 3000 },
      examsDir: path.resolve('./exams'),
      aiProvider: 'mock',
      anthropicApiKey: null,
      mockAiChunkDelayMs: 40,
      candidateAiRequestsPerMinute: 20,
      sessionSweepSeconds: 15,
      login: { cookieSecure: false, authSessionHours: 12, maxFailures: 5, lockMinutes: 15, attemptsPerIpPerMinute: 600 },
      sessionCookie: 'aim_candidate',
      requestHostHeader: 'host',
      webDistDir: null,
    });
  });

  it('Anthropic 설정이면 키 앞뒤 공백을 지우고, 모의 지연 값은 적혀 있어도 쓰지 않는다', () => {
    // Arrange
    const env = candidateEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  sk-ant-test  ', MOCK_AI_CHUNK_DELAY_MS: '40' });

    // Act
    const config = loadCandidateServerConfig(env);

    // Assert
    expect(config.aiProvider).toBe('anthropic');
    expect(config.anthropicApiKey).toBe('sk-ant-test');
    expect(config.mockAiChunkDelayMs).toBeNull();
  });

  it('Anthropic 설정은 모의 지연 값이 없어도 통과한다', () => {
    const env = without(candidateEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' }), 'MOCK_AI_CHUNK_DELAY_MS');

    expect(loadCandidateServerConfig(env).mockAiChunkDelayMs).toBeNull();
  });

  it('모의 AI에서 키가 공백뿐이면 키 없음(null)으로 본다', () => {
    const config = loadCandidateServerConfig(candidateEnv({ ANTHROPIC_API_KEY: '   ' }));

    expect(config.anthropicApiKey).toBeNull();
  });

  it('모의 AI에서도 키가 적혀 있으면 공백을 지워 보관한다', () => {
    const config = loadCandidateServerConfig(candidateEnv({ ANTHROPIC_API_KEY: ' sk-ant-kept ' }));

    expect(config.anthropicApiKey).toBe('sk-ant-kept');
  });

  it('모의 지연 0ms를 허용한다', () => {
    const config = loadCandidateServerConfig(candidateEnv({ MOCK_AI_CHUNK_DELAY_MS: '0' }));

    expect(config.mockAiChunkDelayMs).toBe(0);
  });

  it('COOKIE_SECURE=true면 보안 쿠키를 켠다', () => {
    const config = loadCandidateServerConfig(candidateEnv({ COOKIE_SECURE: 'true' }));

    expect(config.login.cookieSecure).toBe(true);
  });

  it('웹 빌드 폴더가 적혀 있으면 절대 경로로 바꾸고, 없으면 API만 제공한다(null)', () => {
    const withWeb = loadCandidateServerConfig(candidateEnv({ CANDIDATE_WEB_DIST_DIR: './web/dist/candidate' }));
    const withoutWeb = loadCandidateServerConfig(without(candidateEnv(), 'CANDIDATE_WEB_DIST_DIR'));

    expect(withWeb.webDistDir).toBe(path.resolve('./web/dist/candidate'));
    expect(withoutWeb.webDistDir).toBeNull();
  });
});

describe('수험생 서버 설정: 빠지거나 틀린 값', () => {
  it.each(REQUIRED_VARIABLES)('%s가 없으면 그 이름을 적은 ConfigError를 던진다', (variable) => {
    // Arrange
    const env = without(candidateEnv(), variable);

    // Act
    const load = () => loadCandidateServerConfig(env);

    // Assert
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(variable);
  });

  it.each([
    ['CANDIDATE_SERVER_HOST', ''],
    ['CANDIDATE_SERVER_PORT', '0'],
    ['CANDIDATE_SERVER_PORT', '65536'],
    ['CANDIDATE_SERVER_PORT', 'http'],
    ['CANDIDATE_SERVER_DB_MAX_CONNECTIONS', '0'],
    ['EXAMS_DIR', ''],
    ['AI_PROVIDER', 'openai'],
    ['MOCK_AI_CHUNK_DELAY_MS', '-1'],
    ['MOCK_AI_CHUNK_DELAY_MS', '2.5'],
    ['CANDIDATE_AI_REQUESTS_PER_MINUTE', '0'],
    ['SESSION_SWEEP_SECONDS', '1.5'],
    ['COOKIE_SECURE', 'yes'],
    ['AUTH_SESSION_HOURS', '73'],
    ['AUTH_SESSION_HOURS', '0'],
    ['LOGIN_MAX_FAILURES', '0'],
    ['LOGIN_LOCK_MINUTES', 'abc'],
    ['LOGIN_ATTEMPTS_PER_IP_PER_MINUTE', '0'],
  ])('%s=%j는 거부한다', (variable, value) => {
    const load = () => loadCandidateServerConfig(candidateEnv({ [variable]: value }));

    expect(load).toThrow(ConfigError);
    expect(load).toThrow(variable);
  });

  it('AI_PROVIDER=anthropic인데 키가 없거나 공백뿐이면 거부한다', () => {
    const missing = () => loadCandidateServerConfig(without(candidateEnv({ AI_PROVIDER: 'anthropic' }), 'ANTHROPIC_API_KEY'));
    const blank = () => loadCandidateServerConfig(candidateEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  ' }));

    expect(missing).toThrow(/ANTHROPIC_API_KEY: AI_PROVIDER=anthropic이면 필수입니다/u);
    expect(blank).toThrow(/ANTHROPIC_API_KEY: AI_PROVIDER=anthropic이면 필수입니다/u);
  });

  it('AI_PROVIDER=mock인데 모의 지연 값이 없으면 거부한다', () => {
    const load = () => loadCandidateServerConfig(without(candidateEnv(), 'MOCK_AI_CHUNK_DELAY_MS'));

    expect(load).toThrow(/MOCK_AI_CHUNK_DELAY_MS: AI_PROVIDER=mock이면 필수입니다/u);
  });

  it('틀린 항목을 한 번에 모두 적고 예시 파일을 안내한다', () => {
    // Arrange
    const env = without(without(candidateEnv(), 'EXAMS_DIR'), 'SESSION_SWEEP_SECONDS');

    // Act
    let caught: unknown;
    try {
      loadCandidateServerConfig(env);
    } catch (error) {
      caught = error;
    }

    // Assert
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect((caught as ConfigError).name).toBe('ConfigError');
    expect(message).toContain('수험생 서버 환경변수가 올바르지 않습니다');
    expect(message).toContain('infra/.env.example');
    expect(message).toContain('- EXAMS_DIR:');
    expect(message).toContain('- SESSION_SWEEP_SECONDS:');
  });
});

describe('수험생 서버 설정: DB 접속 변수', () => {
  it.each(['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'CANDIDATE_SERVER_DB_USER', 'CANDIDATE_SERVER_DB_PASSWORD'])(
    '%s가 없으면 DB 접속 오류를 던진다',
    (variable) => {
      const load = () => loadCandidateServerConfig(without(candidateEnv(), variable));

      expect(load).toThrow(DatabaseConnectionConfigError);
      expect(load).toThrow(variable);
    },
  );

  it('DB 이름에 대문자·하이픈이 있으면 거부한다', () => {
    const load = () => loadCandidateServerConfig(candidateEnv({ DATABASE_NAME: 'AI-Measurement' }));

    expect(load).toThrow(/DATABASE_NAME: DB 이름은 소문자·숫자·밑줄입니다/u);
  });

  it('다른 프로세스(관리자 서버)의 DB 계정으로는 접속 설정을 만들지 않는다', () => {
    // Arrange
    const env = {
      ...without(without(candidateEnv(), 'CANDIDATE_SERVER_DB_USER'), 'CANDIDATE_SERVER_DB_PASSWORD'),
      ...databaseEnv('ADMIN_SERVER_DB_USER', 'ADMIN_SERVER_DB_PASSWORD'),
    };

    // Act
    const load = () => loadCandidateServerConfig(env);

    // Assert
    expect(load).toThrow(DatabaseConnectionConfigError);
    expect(load).toThrow(/CANDIDATE_SERVER_DB_USER: 필수입니다[\s\S]*CANDIDATE_SERVER_DB_PASSWORD: 필수입니다/u);
  });
});
