/**
 * 로컬 개발용 PostgreSQL(embedded-postgres)을 띄운다. 창을 닫거나 Ctrl+C로 멈춘다.
 * 데이터는 DEV_DATABASE_DIR에 남는다. 운영에서는 쓰지 않는다(결정 D1).
 * 포트·DB 이름·슈퍼유저 계정은 서버가 쓰는 DATABASE_PORT, DATABASE_NAME, MIGRATION_DB_USER/PASSWORD를 그대로 쓴다.
 * 실행: npm run db:dev
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { z } from 'zod';

const env = z
  .object({
    DEV_DATABASE_DIR: z.string().min(1),
    DATABASE_PORT: z.coerce.number().int().min(1024).max(65535),
    DATABASE_NAME: z.string().regex(/^[a-z_][a-z0-9_]*$/u),
    MIGRATION_DB_USER: z.string().regex(/^[a-z_][a-z0-9_]*$/u),
    MIGRATION_DB_PASSWORD: z.string().min(1),
  })
  .parse(process.env);

const dataDir = path.resolve(env.DEV_DATABASE_DIR);
const postgres = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: env.DATABASE_PORT,
  user: env.MIGRATION_DB_USER,
  password: env.MIGRATION_DB_PASSWORD,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (message) => process.stderr.write(`${String(message)}\n`),
});

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
  await postgres.initialise();
  process.stdout.write(`새 데이터 폴더를 만들었습니다: ${dataDir}\n`);
}
await postgres.start();
const client = postgres.getPgClient();
await client.connect();
const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [env.DATABASE_NAME]);
await client.end();
if (existing.rowCount === 0) await postgres.createDatabase(env.DATABASE_NAME);

process.stdout.write(`PostgreSQL 실행 중: postgres://${env.MIGRATION_DB_USER}:***@127.0.0.1:${env.DATABASE_PORT}/${env.DATABASE_NAME}\n멈추려면 Ctrl+C\n`);
const stop = async () => {
  await postgres.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
await new Promise(() => {});
