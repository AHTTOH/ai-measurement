/**
 * 운영자 계정을 만든다(결정 D8). 비밀번호는 셸 기록에 남지 않도록 환경변수 NEW_ADMIN_PASSWORD로 받는다.
 * 관리자 서버 DB 역할은 admins에 쓸 수 없으므로 스키마 소유자 계정(MIGRATION_DB_USER)으로 접속한다.
 * 실행 예(PowerShell): $env:NEW_ADMIN_PASSWORD='...'; npx tsx --env-file=.env scripts/create-admin.ts --username operator
 */
import { parseArgs } from 'node:util';
import { createDatabase, databaseConnectionFromEnv, tables } from '@ai-measurement/infra';
import { hashSecret } from '@ai-measurement/server';

const MIN_PASSWORD_LENGTH = 12;

const { values } = parseArgs({ options: { username: { type: 'string' } } });
const username = values.username?.trim();
const password = process.env['NEW_ADMIN_PASSWORD'];

if (username === undefined || !/^[a-z0-9._-]{3,64}$/u.test(username)) {
  process.stderr.write('--username은 영문 소문자·숫자·._- 3~64자여야 합니다\n');
  process.exit(1);
}
if (password === undefined || password.length < MIN_PASSWORD_LENGTH) {
  process.stderr.write(`NEW_ADMIN_PASSWORD 환경변수에 ${MIN_PASSWORD_LENGTH}자 이상 비밀번호를 넣으십시오\n`);
  process.exit(1);
}
const handle = createDatabase(databaseConnectionFromEnv(process.env, 'MIGRATION_DB_USER', 'MIGRATION_DB_PASSWORD'), { maxConnections: 1 });
try {
  await handle.db.insert(tables.admins).values({ username, passwordHash: await hashSecret(password) });
  process.stdout.write(`운영자 계정을 만들었습니다: ${username}\n`);
} finally {
  await handle.close();
}
