import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { ACCESS_ROLES, applyDatabaseLogins, createDatabase, runMigrations, tables, type DatabaseConnection } from '@ai-measurement/infra';
import { hashSecret } from '@ai-measurement/server';
import { startRoundRobinProxy } from './round-robin-proxy';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('포트를 얻지 못했습니다'))));
    });
  });
}

function startProcess(entry: string, env: NodeJS.ProcessEnv, readyText: string, nodeArgs: readonly string[]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, '--import', 'tsx', entry], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${entry}가 시작되지 않았습니다:\n${output}`)), 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(readyText)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`${entry}가 종료되었습니다(code ${String(code)}):\n${output}`)));
  });
}

export interface IsolatedStackOptions {
  /** 이름표(데이터 폴더 이름에 쓴다) */
  label: string;
  /** 응시자가 접속하는 포트. 수험생 서버가 여러 대면 이 포트에 라운드로빈 프록시를 띄운다 */
  candidatePort: number;
  /** 수험생 서버 대수(1 이상) */
  candidateInstances: number;
  adminPort: number;
  /** 수험생 서버 환경변수 덮어쓰기(모의 AI 지연, 요청 한도 등) */
  candidateEnv: Record<string, string>;
  withWorker: boolean;
  /** 수험생 서버를 디버거 포트와 함께 띄운다(부하 테스트 CPU 프로파일용) */
  inspectCandidates: boolean;
}

export interface IsolatedStack {
  candidateUrl: string;
  adminUrl: string;
  admin: { username: string; password: string };
  /** 스키마 소유자 접속 정보. 부하 테스트의 DB 대기 표본 수집 같은 진단에만 쓴다 */
  ownerConnection: DatabaseConnection;
  /** inspectCandidates일 때 수험생 서버별 디버거 포트 */
  candidateInspectPorts: number[];
  stop(): Promise<void>;
}

const DATABASE_NAME = 'aim_isolated';
/** 서버가 붙는 주소이자 테스트가 접속하는 주소 */
export const LOOPBACK_HOST = '127.0.0.1';
/** 두 서버가 함께 쓰는 로그인 정책 */
const LOGIN_POLICY_ENV = {
  REQUEST_HOST_HEADER: 'host',
  COOKIE_SECURE: 'false',
  AUTH_SESSION_HOURS: '12',
  LOGIN_MAX_FAILURES: '5',
  LOGIN_LOCK_MINUTES: '15',
  LOGIN_ATTEMPTS_PER_IP_PER_MINUTE: '2000',
};

function randomSecret(): string {
  return randomBytes(18).toString('base64url');
}

/** 프로세스 하나가 받을 DB 접속 환경변수. 다른 역할의 계정은 넘기지 않는다 */
function databaseEnv(connection: DatabaseConnection, userVariable: string, passwordVariable: string): Record<string, string> {
  return {
    DATABASE_HOST: connection.host,
    DATABASE_PORT: String(connection.port),
    DATABASE_NAME: connection.database,
    DATABASE_SSL: connection.ssl,
    [userVariable]: connection.user,
    [passwordVariable]: connection.password,
  };
}

/**
 * 전용 PostgreSQL + 수험생 서버(1대 이상, 여러 대면 라운드로빈 프록시 뒤) + 관리자 서버(각자 빌드된 웹 포함, 모의 AI)
 * + 선택적으로 채점 워커(모의 LLM)를 띄운다.
 * 운영과 같이 프로세스마다 다른 DB 계정으로 접속한다. E2E와 부하 테스트가 함께 쓴다.
 */
export async function startIsolatedStack(options: IsolatedStackOptions): Promise<IsolatedStack> {
  const pgPort = await freePort();
  const dataDir = path.join(repoRoot, 'workspace', `${options.label}-postgres-${process.pid}`);
  await rm(dataDir, { recursive: true, force: true });
  const ownerPassword = randomSecret();
  const postgres = new EmbeddedPostgres({ databaseDir: dataDir, port: pgPort, user: 'postgres', password: ownerPassword, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase(DATABASE_NAME);
  const base = { host: '127.0.0.1', port: pgPort, database: DATABASE_NAME, ssl: 'disable' as const };
  const logins = {
    candidate: { role: ACCESS_ROLES.candidateServer, user: `${options.label}_candidate_login`, password: randomSecret() },
    admin: { role: ACCESS_ROLES.adminServer, user: `${options.label}_admin_login`, password: randomSecret() },
    worker: { role: ACCESS_ROLES.gradingWorker, user: `${options.label}_grading_login`, password: randomSecret() },
  };
  const admin = { username: `${options.label}-operator`, password: randomSecret() };
  const handle = createDatabase({ ...base, user: 'postgres', password: ownerPassword }, { maxConnections: 1 });
  await runMigrations(handle.db);
  await applyDatabaseLogins(handle.db, Object.values(logins));
  await handle.db.insert(tables.admins).values({ username: admin.username, passwordHash: await hashSecret(admin.password) });
  await handle.close();

  const common = { ...process.env, EXAMS_DIR: path.join(repoRoot, 'exams'), GRADING_LLM_PROVIDER: 'mock', ANTHROPIC_API_KEY: '' };
  const connectionOf = (login: { user: string; password: string }): DatabaseConnection => ({ ...base, user: login.user, password: login.password });
  if (!Number.isInteger(options.candidateInstances) || options.candidateInstances < 1) throw new Error(`수험생 서버 대수가 올바르지 않습니다: ${options.candidateInstances}`);
  const single = options.candidateInstances === 1;
  const instancePorts = single ? [options.candidatePort] : await Promise.all(Array.from({ length: options.candidateInstances }, () => freePort()));
  const inspectPorts = options.inspectCandidates ? await Promise.all(instancePorts.map(() => freePort())) : [];
  const candidateServers = await Promise.all(
    instancePorts.map((port, index) =>
      startProcess(
        'server/src/candidate-main.ts',
        {
          ...common,
          ...databaseEnv(connectionOf(logins.candidate), 'CANDIDATE_SERVER_DB_USER', 'CANDIDATE_SERVER_DB_PASSWORD'),
          ...LOGIN_POLICY_ENV,
          CANDIDATE_SERVER_HOST: LOOPBACK_HOST,
          CANDIDATE_SERVER_PORT: String(port),
          CANDIDATE_SESSION_COOKIE: 'aim_candidate',
          CANDIDATE_SERVER_DB_MAX_CONNECTIONS: '20',
          AI_PROVIDER: 'mock',
          SESSION_SWEEP_SECONDS: '15',
          CANDIDATE_WEB_DIST_DIR: path.join(repoRoot, 'web', 'dist', 'candidate'),
          ...options.candidateEnv,
        },
        'candidate_server_started',
        options.inspectCandidates ? [`--inspect=${LOOPBACK_HOST}:${inspectPorts[index]}`] : [],
      ),
    ),
  );
  const proxy = single ? null : await startRoundRobinProxy(instancePorts.map((port) => `http://${LOOPBACK_HOST}:${port}`), options.candidatePort);
  const adminServer = await startProcess(
    'server/src/admin-main.ts',
    {
      ...common,
      ...databaseEnv(connectionOf(logins.admin), 'ADMIN_SERVER_DB_USER', 'ADMIN_SERVER_DB_PASSWORD'),
      ...LOGIN_POLICY_ENV,
      ADMIN_SERVER_HOST: LOOPBACK_HOST,
      ADMIN_SERVER_PORT: String(options.adminPort),
      ADMIN_SESSION_COOKIE: 'aim_admin',
      ADMIN_SERVER_DB_MAX_CONNECTIONS: '5',
      UPLOAD_MAX_MB: '50',
      ADMIN_WEB_DIST_DIR: path.join(repoRoot, 'web', 'dist', 'admin'),
    },
    'admin_server_started',
    [],
  );
  const worker = options.withWorker
    ? await startProcess(
        'grading/src/worker-main.ts',
        {
          ...common,
          ...databaseEnv(connectionOf(logins.worker), 'GRADING_WORKER_DB_USER', 'GRADING_WORKER_DB_PASSWORD'),
          GRADING_WORKER_DB_MAX_CONNECTIONS: '4',
          GRADING_POLL_SECONDS: '1',
          GRADING_BATCH_POLL_SECONDS: '2',
          GRADING_DIRECT_CONCURRENCY: '2',
          GRADING_JOB_LOCK_MINUTES: '5',
        },
        'grading_worker_started',
        [],
      )
    : null;

  return {
    // 서버가 127.0.0.1(IPv4)에만 붙으므로 주소도 IPv4로 쓴다. localhost는 IPv6(::1)부터 시도해
    // Windows에서 거절된 연결을 약 2초 재시도한 뒤에야 IPv4로 넘어간다(2026-09-27 부하 테스트에서 확인)
    candidateUrl: `http://${LOOPBACK_HOST}:${options.candidatePort}`,
    adminUrl: `http://${LOOPBACK_HOST}:${options.adminPort}`,
    admin,
    ownerConnection: { ...base, user: 'postgres', password: ownerPassword },
    candidateInspectPorts: inspectPorts,
    stop: async () => {
      await proxy?.stop();
      for (const candidateServer of candidateServers) candidateServer.kill();
      adminServer.kill();
      worker?.kill();
      await postgres.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
