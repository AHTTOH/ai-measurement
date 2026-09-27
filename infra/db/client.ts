import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { DatabaseConnection } from './connection';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** 트랜잭션 안팎 어디서든 쓰는 쿼리 실행기 */
export type DbExecutor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  /** LISTEN/NOTIFY 등 드라이버 기능이 필요할 때 쓰는 원본 클라이언트 */
  client: postgres.Sql;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** 커넥션 풀 크기 */
  maxConnections: number;
}

export function createDatabase(connection: DatabaseConnection, options: DatabaseOptions): DatabaseHandle {
  const client = postgres({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.user,
    password: connection.password,
    ssl: connection.ssl === 'require' ? 'require' : false,
    max: options.maxConnections,
    onnotice: () => {},
  });
  return {
    db: drizzle(client, { schema }),
    client,
    close: () => client.end({ timeout: 5 }),
  };
}

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** 스키마 소유자(마이그레이션 계정)로 실행한다. 역할 생성과 권한 부여도 마이그레이션에 들어 있다 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

/** 연결을 여는 동안 잡아 두는 시간. 모든 연결이 동시에 열리도록 쿼리가 겹치게 한다 */
const WARM_UP_HOLD_SECONDS = 0.1;

/**
 * 풀의 연결을 미리 연다. PostgreSQL은 연결마다 프로세스를 띄우고(Windows에서 특히 느리다), 드라이버는 필요할 때 연결을 연다.
 * 시험 시작 순간 로그인이 몰리면 요청이 연결 생성을 줄지어 기다리게 된다(2026-09-27 부하 테스트에서 확인). 기동 때 한 번 부른다.
 */
export async function warmUpConnections(handle: DatabaseHandle, count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, () => handle.client`SELECT pg_sleep(${WARM_UP_HOLD_SECONDS})`));
}
