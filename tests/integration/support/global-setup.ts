import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { ACCESS_ROLES, applyDatabaseLogins, createDatabase, runMigrations, type DatabaseConnection } from '@ai-measurement/infra';

/** 프로세스 역할별 접속 정보. 운영과 같이 서버마다 다른 DB 계정을 쓴다 */
export interface TestConnections {
  owner: DatabaseConnection;
  candidateServer: DatabaseConnection;
  adminServer: DatabaseConnection;
  gradingWorker: DatabaseConnection;
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseConnections: TestConnections;
  }
}

const OWNER_PASSWORD = 'integration-test';
/** 테스트 DB 전용 로그인. 비밀번호 형식 규칙(영문·숫자·_·- 16자 이상)을 지킨다 */
const TEST_LOGINS = {
  candidateServer: { role: ACCESS_ROLES.candidateServer, user: 'test_candidate_login', password: 'test-candidate-password' },
  adminServer: { role: ACCESS_ROLES.adminServer, user: 'test_admin_login', password: 'test-admin-password-1' },
  gradingWorker: { role: ACCESS_ROLES.gradingWorker, user: 'test_grading_login', password: 'test-grading-password' },
} as const;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('포트를 얻지 못했습니다'))));
    });
  });
}

/** 테스트용 PostgreSQL을 띄우고 마이그레이션과 역할별 로그인을 적용한다. 끝나면 데이터 폴더까지 지운다 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = await freePort();
  const dataDir = path.join(repoRoot, 'workspace', `test-postgres-${process.pid}`);
  await rm(dataDir, { recursive: true, force: true });
  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: 'postgres',
    password: OWNER_PASSWORD,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('aim_test');
  const base = { host: '127.0.0.1', port, database: 'aim_test', ssl: 'disable' as const };
  const owner: DatabaseConnection = { ...base, user: 'postgres', password: OWNER_PASSWORD };
  const handle = createDatabase(owner, { maxConnections: 2 });
  await runMigrations(handle.db);
  await applyDatabaseLogins(handle.db, Object.values(TEST_LOGINS));
  await handle.close();
  const connectionOf = (login: { user: string; password: string }): DatabaseConnection => ({ ...base, user: login.user, password: login.password });
  project.provide('databaseConnections', {
    owner,
    candidateServer: connectionOf(TEST_LOGINS.candidateServer),
    adminServer: connectionOf(TEST_LOGINS.adminServer),
    gradingWorker: connectionOf(TEST_LOGINS.gradingWorker),
  });

  return async () => {
    await postgres.stop();
    await rm(dataDir, { recursive: true, force: true });
  };
}
