import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, inject } from 'vitest';
import { createDatabase, tables, type Database, type DatabaseHandle } from '@ai-measurement/infra';
import {
  buildAdminApp,
  buildAdminServices,
  buildCandidateApp,
  buildCandidateServices,
  consoleLogger,
  hashSecret,
  MockGateway,
  silentLogger,
  STREAM_HUB_TIMING,
  type AdminServerConfig,
  type AdminServices,
  type AiGateway,
  type CandidateServerConfig,
  type CandidateServices,
  type Clock,
  type LoginPolicy,
  type StreamHubTiming,
} from '@ai-measurement/server';
import type { Hono } from 'hono';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SAMPLE_SLUG = 'sample-ai-practice';
const EXAMS_DIR = path.join(repoRoot, 'exams');
const POOL_SIZE = 10;

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }
}

export function testLoginPolicy(overrides: Partial<LoginPolicy> = {}): LoginPolicy {
  return { cookieSecure: false, authSessionHours: 12, maxFailures: 5, lockMinutes: 15, attemptsPerIpPerMinute: 1000, ...overrides };
}

export function testCandidateConfig(login: LoginPolicy, overrides: Partial<CandidateServerConfig> = {}): CandidateServerConfig {
  return {
    database: inject('databaseConnections').candidateServer,
    databaseMaxConnections: POOL_SIZE,
    listen: { host: '127.0.0.1', port: 0 },
    examsDir: EXAMS_DIR,
    aiProvider: 'mock',
    anthropicApiKey: null,
    mockAiChunkDelayMs: 0,
    candidateAiRequestsPerMinute: 1000,
    sessionSweepSeconds: 60,
    login,
    sessionCookie: 'aim_candidate',
    requestHostHeader: 'host',
    webDistDir: null,
    ...overrides,
  };
}

export function testAdminConfig(login: LoginPolicy, overrides: Partial<AdminServerConfig> = {}): AdminServerConfig {
  return {
    database: inject('databaseConnections').adminServer,
    databaseMaxConnections: POOL_SIZE,
    listen: { host: '127.0.0.1', port: 0 },
    examsDir: EXAMS_DIR,
    gradingLlmProvider: 'mock',
    uploadMaxBytes: 20 * 1024 * 1024,
    login,
    sessionCookie: 'aim_admin',
    requestHostHeader: 'host',
    webDistDir: null,
    ...overrides,
  };
}

/** 요청을 받을 수 있는 앱(Hono 앱 또는 여러 앱을 번갈아 부르는 묶음) */
export type RequestTarget = Pick<Hono, 'request'>;

/** 두 서버 앱. 브라우저 하나가 두 서버를 부르듯 TestClient가 경로로 나눠 보낸다 */
export interface TestApps {
  candidate: RequestTarget;
  admin: RequestTarget;
}

export interface TestServer {
  apps: TestApps;
  /** 수험생 서버 서비스(DB 역할 aim_candidate_server) */
  candidate: CandidateServices;
  /** 관리자 서버 서비스(DB 역할 aim_admin_server) */
  admin: AdminServices;
  /** 스키마 소유자 연결. 픽스처 준비·결과 확인 전용이며 서버 코드는 쓰지 않는다 */
  db: Database;
  /** 역할별 연결. 서버 서비스가 쓰는 것과 같은 계정이다(권한 테스트·채점 워커용) */
  roles: RoleDatabases;
  clock: FakeClock;
  close(): Promise<void>;
}

export interface RoleDatabases {
  candidateServer: Database;
  adminServer: Database;
  gradingWorker: Database;
}

export interface TestServerOptions {
  login?: Partial<LoginPolicy>;
  candidateConfig?: Partial<CandidateServerConfig>;
  adminConfig?: Partial<AdminServerConfig>;
  ai?: AiGateway;
  start?: Date;
  streamTiming?: Partial<StreamHubTiming>;
}

/**
 * 역할별 연결 풀은 테스트 파일 하나 안에서 재사용한다. Windows의 PostgreSQL은 연결마다 프로세스를 새로 띄워
 * 테스트마다 네 역할의 연결을 새로 여는 비용이 크다. 파일이 끝나면 닫는다.
 */
interface SharedPools {
  owner: DatabaseHandle;
  candidateServer: DatabaseHandle;
  adminServer: DatabaseHandle;
  gradingWorker: DatabaseHandle;
}

let sharedPools: SharedPools | null = null;

function pools(): SharedPools {
  if (sharedPools === null) {
    const connections = inject('databaseConnections');
    sharedPools = {
      owner: createDatabase(connections.owner, { maxConnections: POOL_SIZE }),
      candidateServer: createDatabase(connections.candidateServer, { maxConnections: POOL_SIZE }),
      adminServer: createDatabase(connections.adminServer, { maxConnections: POOL_SIZE }),
      gradingWorker: createDatabase(connections.gradingWorker, { maxConnections: POOL_SIZE }),
    };
  }
  return sharedPools;
}

afterAll(async () => {
  if (sharedPools === null) return;
  const closing = Object.values(sharedPools).map((handle) => handle.close());
  sharedPools = null;
  await Promise.all(closing);
});

export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const login = testLoginPolicy(options.login);
  const candidateConfig = testCandidateConfig(login, options.candidateConfig);
  const adminConfig = testAdminConfig(login, options.adminConfig);
  const shared = pools();
  await resetDatabase(shared.owner.db);
  const clock = new FakeClock(options.start ?? new Date('2026-09-27T01:00:00Z'));
  // TEST_LOG=1이면 서버 로그를 출력한다(실패 원인 확인용)
  const logger = process.env['TEST_LOG'] === '1' ? consoleLogger : silentLogger;
  const candidate = buildCandidateServices({
    database: shared.candidateServer,
    streamTiming: { ...STREAM_HUB_TIMING, ...options.streamTiming },
    config: candidateConfig,
    clock,
    ai: options.ai ?? new MockGateway({ chunkDelayMs: 0 }),
    logger,
  });
  await candidate.hub.start();
  const admin = buildAdminServices({ db: shared.adminServer.db, config: adminConfig, clock, logger });
  return {
    apps: { candidate: buildCandidateApp(candidate), admin: buildAdminApp(admin) },
    candidate,
    admin,
    db: shared.owner.db,
    roles: { candidateServer: shared.candidateServer.db, adminServer: shared.adminServer.db, gradingWorker: shared.gradingWorker.db },
    clock,
    // 연결 풀은 파일 단위로 재사용하므로 여기서 닫지 않는다. 테스트 간 상태는 resetDatabase가 지운다
    close: () => candidate.hub.stop(),
  };
}

export interface CandidateInstance {
  app: RequestTarget;
  services: CandidateServices;
  close(): Promise<void>;
}

/**
 * 같은 DB를 쓰는 수험생 서버를 한 대 더 만든다(연결 풀·스트림 허브·서비스가 따로다). 다중 인스턴스 테스트용.
 * 설정과 시계는 기존 서버와 같다.
 */
export async function createCandidateInstance(server: TestServer, options: { ai: AiGateway; streamTiming?: Partial<StreamHubTiming> }): Promise<CandidateInstance> {
  const handle = createDatabase(inject('databaseConnections').candidateServer, { maxConnections: POOL_SIZE });
  const services = buildCandidateServices({
    database: handle,
    streamTiming: { ...STREAM_HUB_TIMING, ...options.streamTiming },
    config: server.candidate.config,
    clock: server.clock,
    ai: options.ai,
    logger: server.candidate.logger,
  });
  await services.hub.start();
  return {
    app: buildCandidateApp(services),
    services,
    close: async () => {
      await services.hub.stop();
      await handle.close();
    },
  };
}

/** 자식 테이블부터 지우는 순서(외래키 순서의 역순) */
const TABLES_CHILD_FIRST = [
  'violations', 'session_scores', 'grade_items', 'grading_jobs', 'audit_events', 'client_events', 'answers', 'token_ledger',
  'attachments', 'attachment_blobs', 'messages', 'ai_streams', 'conversations', 'exam_sessions', 'auth_sessions', 'candidates', 'exams', 'admins',
  'rate_limit_hits',
] as const;

/**
 * 모든 테이블을 비운다. 테스트마다 깨끗한 상태에서 시작한다.
 * 행이 적으므로 TRUNCATE(파일을 새로 만든다, Windows에서 약 1초)보다 DELETE가 훨씬 빠르다.
 */
export async function resetDatabase(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of TABLES_CHILD_FIRST) await tx.execute(sql.raw(`DELETE FROM ${table}`));
  });
}

export async function createAdmin(db: Database, username = 'admin', password = 'admin-password-1'): Promise<{ id: string; username: string; password: string }> {
  const [admin] = await db.insert(tables.admins).values({ username, passwordHash: await hashSecret(password) }).returning();
  if (admin === undefined) throw new Error('관리자를 만들지 못했습니다');
  return { id: admin.id, username, password };
}

/** 샘플 시험을 등록하고 열고 응시자를 발급한다 */
export async function prepareOpenExam(server: TestServer, candidateCount = 2): Promise<{ examId: string; adminId: string; candidates: Array<{ candidateNo: string; pin: string }> }> {
  const admin = await createAdmin(server.db);
  const { examId } = await server.admin.examImport.importDirectory(SAMPLE_SLUG, admin.id);
  await server.admin.examAdmin.changeStatus(examId, 'open', admin.id);
  const candidates = await server.admin.examAdmin.generateCandidates(examId, 'T', candidateCount, admin.id);
  return { examId, adminId: admin.id, candidates };
}

/** app.request에는 실제 소켓이 없으므로 서버가 읽는 접속 주소를 흉내 낸다 */
export function testConnectionEnv(address: string) {
  return { incoming: { socket: { remoteAddress: address, remotePort: 50_000, remoteFamily: 'IPv4' } } };
}

const ADMIN_API_PREFIX = '/api/admin/';

/**
 * 쿠키를 들고 다니는 테스트용 HTTP 클라이언트(app.request 사용, 실제 소켓 없음).
 * /api/admin/ 요청은 관리자 서버로, 나머지는 수험생 서버로 보낸다.
 * 쿠키는 포트를 구분하지 않으므로 한 저장소를 함께 쓴다(실제 브라우저와 같다).
 */
export class TestClient {
  constructor(
    private readonly apps: TestApps,
    private readonly address = '10.0.0.1',
    private readonly cookies = new Map<string, string>(),
  ) {}

  /** 같은 쿠키(같은 브라우저)로 다른 서버에 붙는 클라이언트. 수험생 서버 여러 대 테스트용 */
  via(apps: TestApps): TestClient {
    return new TestClient(apps, this.address, this.cookies);
  }

  async request<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: { ok: boolean; data: T; error: { code: string; message: string; details?: unknown } } }> {
    const response = await this.raw(method, url, body, headers);
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  }

  async raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const cookieHeader = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const app = url.startsWith(ADMIN_API_PREFIX) ? this.apps.admin : this.apps.candidate;
    const response = await app.request(
      url,
      {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(cookieHeader.length > 0 ? { cookie: cookieHeader } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      testConnectionEnv(this.address),
    );
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name === undefined) continue;
      const value = rest.join('=');
      if (value === '' || /max-age=0/iu.test(setCookie)) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    return response;
  }

  async loginCandidate(candidateNo: string, pin: string): Promise<void> {
    const result = await this.request('POST', '/api/candidate/login', { candidateNo, pin });
    if (result.status !== 200) throw new Error(`응시자 로그인 실패: ${JSON.stringify(result.body)}`);
  }

  async loginAdmin(username: string, password: string): Promise<void> {
    const result = await this.request('POST', '/api/admin/login', { username, password });
    if (result.status !== 200) throw new Error(`관리자 로그인 실패: ${JSON.stringify(result.body)}`);
  }
}

/** 대화의 AI 응답이 끝날 때까지 기다린다 */
export async function waitForResponse(services: CandidateServices, conversationId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await services.hub.isBusy(conversationId)) {
    if (Date.now() > deadline) throw new Error('AI 응답이 끝나지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** SSE 이벤트 사이 구분(빈 줄) */
const SSE_EVENT_SEPARATOR = '\n\n';

/** SSE 응답을 끝 이벤트(done·failed·idle)까지 읽는다 */
export async function readSse(response: Response, timeoutMs = 15_000): Promise<SseEvent[]> {
  if (response.body === null) throw new Error('SSE 본문이 없습니다');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) return events;
      buffer += value;
      for (let boundary = buffer.indexOf(SSE_EVENT_SEPARATOR); boundary >= 0; boundary = buffer.indexOf(SSE_EVENT_SEPARATOR)) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + SSE_EVENT_SEPARATOR.length);
        const event = /^event: (.*)$/mu.exec(block)?.[1];
        const data = /^data: (.*)$/mu.exec(block)?.[1];
        if (event === undefined || data === undefined) continue;
        events.push({ event, data: JSON.parse(data) });
        if (event === 'done' || event === 'failed' || event === 'idle') return events;
      }
    }
    throw new Error(`SSE가 ${timeoutMs}ms 안에 끝나지 않았습니다: ${JSON.stringify(events)}`);
  } finally {
    await reader.cancel();
  }
}
