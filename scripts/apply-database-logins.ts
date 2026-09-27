/**
 * 프로세스별 DB 로그인 계정을 만들거나 비밀번호를 바꾸고 역할에 넣는다(결정: 2026-09-27 권한 구조 분리).
 * 수험생 서버·관리자 서버·채점 워커가 각자 다른 계정으로 접속하게 된다. 마이그레이션 뒤에 실행한다.
 * 스키마 소유자 계정(MIGRATION_DB_USER)으로 접속한다. 여러 번 실행해도 결과가 같다.
 * 실행: npm run db:logins
 */
import { ACCESS_ROLES, applyDatabaseLogins, createDatabase, databaseConnectionFromEnv, type DatabaseLogin } from '@ai-measurement/infra';

const LOGIN_VARIABLES = [
  { role: ACCESS_ROLES.candidateServer, user: 'CANDIDATE_SERVER_DB_USER', password: 'CANDIDATE_SERVER_DB_PASSWORD' },
  { role: ACCESS_ROLES.adminServer, user: 'ADMIN_SERVER_DB_USER', password: 'ADMIN_SERVER_DB_PASSWORD' },
  { role: ACCESS_ROLES.gradingWorker, user: 'GRADING_WORKER_DB_USER', password: 'GRADING_WORKER_DB_PASSWORD' },
] as const;

const missing = LOGIN_VARIABLES.flatMap((v) => [v.user, v.password]).filter((name) => (process.env[name] ?? '') === '');
if (missing.length > 0) {
  process.stderr.write(`환경변수가 없습니다: ${missing.join(', ')}. infra/.env.example을 참고하십시오\n`);
  process.exit(1);
}
const logins: DatabaseLogin[] = LOGIN_VARIABLES.map((v) => ({ role: v.role, user: process.env[v.user] ?? '', password: process.env[v.password] ?? '' }));

const handle = createDatabase(databaseConnectionFromEnv(process.env, 'MIGRATION_DB_USER', 'MIGRATION_DB_PASSWORD'), { maxConnections: 1 });
try {
  await applyDatabaseLogins(handle.db, logins);
  process.stdout.write(`DB 로그인 계정을 적용했습니다: ${logins.map((l) => `${l.user}→${l.role}`).join(', ')}\n`);
} finally {
  await handle.close();
}
