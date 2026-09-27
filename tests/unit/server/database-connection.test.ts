import { describe, expect, it } from 'vitest';
import { databaseConnectionFromEnv, DatabaseConnectionConfigError } from '@ai-measurement/infra';

/** DB 접속 설정: SSL 필수 지정, Supabase 풀러 사용자 이름 규칙(2026-09-27) */
const base = {
  DATABASE_HOST: 'aws-0-ap-northeast-2.pooler.supabase.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'postgres',
  DATABASE_SSL: 'require',
  APP_DB_USER: 'aim_candidate_login',
  APP_DB_PASSWORD: 'password-for-test-1234',
};

describe('databaseConnectionFromEnv', () => {
  it('풀러 프로젝트 ref가 있으면 접속 사용자 이름을 계정.ref로 만든다', () => {
    const connection = databaseConnectionFromEnv({ ...base, DATABASE_POOLER_PROJECT_REF: 'jbsmrwkeprsxrvtyblin' }, 'APP_DB_USER', 'APP_DB_PASSWORD');
    expect(connection).toEqual({
      host: base.DATABASE_HOST,
      port: 5432,
      database: 'postgres',
      user: 'aim_candidate_login.jbsmrwkeprsxrvtyblin',
      password: base.APP_DB_PASSWORD,
      ssl: 'require',
    });
  });

  it('풀러 ref가 없으면 계정 이름 그대로 접속한다', () => {
    expect(databaseConnectionFromEnv(base, 'APP_DB_USER', 'APP_DB_PASSWORD').user).toBe('aim_candidate_login');
  });

  it('SSL 설정이 없거나 틀리면 기동을 거부한다', () => {
    const { DATABASE_SSL: _omitted, ...withoutSsl } = base;
    expect(() => databaseConnectionFromEnv(withoutSsl, 'APP_DB_USER', 'APP_DB_PASSWORD')).toThrow(DatabaseConnectionConfigError);
    expect(() => databaseConnectionFromEnv({ ...base, DATABASE_SSL: 'prefer' }, 'APP_DB_USER', 'APP_DB_PASSWORD')).toThrow(DatabaseConnectionConfigError);
  });

  it('형식이 틀린 풀러 ref는 거부한다', () => {
    expect(() => databaseConnectionFromEnv({ ...base, DATABASE_POOLER_PROJECT_REF: 'Bad.Ref' }, 'APP_DB_USER', 'APP_DB_PASSWORD')).toThrow(DatabaseConnectionConfigError);
  });
});
