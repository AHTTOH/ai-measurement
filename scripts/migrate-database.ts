/**
 * infra/db/migrations를 적용한다. 이미 적용한 마이그레이션은 건너뛴다.
 * 스키마 소유자 계정(MIGRATION_DB_USER)으로 접속한다. 역할 생성·권한 부여도 여기서 적용된다.
 * 실행: npm run db:migrate
 */
import { createDatabase, databaseConnectionFromEnv, runMigrations } from '@ai-measurement/infra';

const handle = createDatabase(databaseConnectionFromEnv(process.env, 'MIGRATION_DB_USER', 'MIGRATION_DB_PASSWORD'), { maxConnections: 1 });
try {
  await runMigrations(handle.db);
  process.stdout.write('마이그레이션을 적용했습니다\n');
} finally {
  await handle.close();
}
