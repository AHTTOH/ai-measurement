import { z } from 'zod';

export type DatabaseSslMode = 'require' | 'disable';

/** DB 접속 정보. 호스트·포트·DB 이름·SSL은 모든 프로세스가 같고, 계정만 프로세스(역할)마다 다르다 */
export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  /** 실제 접속에 쓰는 사용자 이름(Supabase 풀러면 '계정.프로젝트ref') */
  user: string;
  password: string;
  /** 운영 DB(Supabase)는 require, 로컬 임베디드 DB는 disable */
  ssl: DatabaseSslMode;
}

/** 접속 환경변수가 빠졌거나 틀렸을 때. 진입점은 이 오류를 스택 없이 안내하고 종료한다 */
export class DatabaseConnectionConfigError extends Error {
  override readonly name = 'DatabaseConnectionConfigError';
}

const sharedSchema = z.object({
  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_NAME: z.string().regex(/^[a-z_][a-z0-9_]*$/u, 'DB 이름은 소문자·숫자·밑줄입니다'),
  DATABASE_SSL: z.enum(['require', 'disable']),
  /**
   * Supabase 풀러(Supavisor)로 접속할 때의 프로젝트 ref. 풀러는 사용자 이름을 '계정.프로젝트ref'로 받는다.
   * 있으면 접속 사용자 이름 뒤에 붙인다. DB 안의 역할 이름(로그인 계정 생성)은 붙이지 않은 이름 그대로다.
   * 없으면 DB에 바로 접속한다(로컬 임베디드 DB)
   */
  DATABASE_POOLER_PROJECT_REF: z.string().regex(/^[a-z0-9]{10,40}$/u, '영문 소문자·숫자 프로젝트 ref입니다').optional(),
});

/** 환경변수에서 접속 정보를 읽는다. 계정 변수 이름은 프로세스마다 다르다(예: CANDIDATE_SERVER_DB_USER) */
export function databaseConnectionFromEnv(env: NodeJS.ProcessEnv, userVariable: string, passwordVariable: string): DatabaseConnection {
  const shared = sharedSchema.safeParse(env);
  const user = z.string().min(1).safeParse(env[userVariable]);
  const password = z.string().min(1).safeParse(env[passwordVariable]);
  const problems = [
    ...(shared.success ? [] : shared.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
    ...(user.success ? [] : [`${userVariable}: 필수입니다`]),
    ...(password.success ? [] : [`${passwordVariable}: 필수입니다`]),
  ];
  if (!shared.success || !user.success || !password.success) {
    throw new DatabaseConnectionConfigError(`DB 접속 환경변수가 올바르지 않습니다. infra/.env.example을 참고하십시오.\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  const ref = shared.data.DATABASE_POOLER_PROJECT_REF;
  return {
    host: shared.data.DATABASE_HOST,
    port: shared.data.DATABASE_PORT,
    database: shared.data.DATABASE_NAME,
    user: ref === undefined ? user.data : `${user.data}.${ref}`,
    password: password.data,
    ssl: shared.data.DATABASE_SSL,
  };
}
