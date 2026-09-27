import { sql } from 'drizzle-orm';
import type { Database } from './client';

/**
 * 프로세스별 DB 역할(마이그레이션 0001_access-roles가 만들고 권한을 준다).
 * 역할 이름은 스키마의 일부이므로 테이블 이름처럼 코드에 둔다.
 */
export const ACCESS_ROLES = {
  candidateServer: 'aim_candidate_server',
  adminServer: 'aim_admin_server',
  gradingWorker: 'aim_grading_worker',
} as const;

export type AccessRole = (typeof ACCESS_ROLES)[keyof typeof ACCESS_ROLES];

export interface DatabaseLogin {
  role: AccessRole;
  user: string;
  password: string;
}

/** DDL에는 값을 바인딩할 수 없으므로 이름과 비밀번호를 엄격한 형식으로만 받는다(따옴표·공백 불가) */
const USER_PATTERN = /^[a-z_][a-z0-9_]{2,62}$/u;
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

function validate(logins: readonly DatabaseLogin[]): void {
  const users = new Set<string>();
  for (const login of logins) {
    if (!USER_PATTERN.test(login.user)) throw new Error(`DB 로그인 이름 형식이 올바르지 않습니다: ${login.user}`);
    if (!PASSWORD_PATTERN.test(login.password)) {
      throw new Error(`DB 비밀번호는 영문·숫자·_·- 16~128자여야 합니다(${login.user})`);
    }
    if (users.has(login.user)) throw new Error(`한 로그인 계정을 두 역할에 쓸 수 없습니다: ${login.user}`);
    users.add(login.user);
    if (Object.values(ACCESS_ROLES).includes(login.user as AccessRole)) throw new Error(`역할 이름을 로그인 계정으로 쓸 수 없습니다: ${login.user}`);
  }
}

/**
 * 역할별 로그인 계정을 만들거나 비밀번호를 바꾸고 역할에 넣는다. 스키마 소유자 계정으로 실행한다.
 * 여러 번 실행해도 결과가 같다.
 */
export async function applyDatabaseLogins(db: Database, logins: readonly DatabaseLogin[]): Promise<void> {
  validate(logins);
  for (const login of logins) {
    await db.execute(
      sql.raw(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${login.user}') THEN
             CREATE ROLE ${login.user} LOGIN PASSWORD '${login.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
           ELSE
             ALTER ROLE ${login.user} WITH LOGIN PASSWORD '${login.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
           END IF;
         END $$;`,
      ),
    );
    await db.execute(sql.raw(`GRANT ${login.role} TO ${login.user}`));
  }
}
