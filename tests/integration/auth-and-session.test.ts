import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tables } from '@ai-measurement/infra';
import type { CandidateStateResponse } from '@ai-measurement/shared';
import { eq } from 'drizzle-orm';
import { createTestServer, prepareOpenExam, TestClient, type TestServer } from './support/test-server';

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer();
});
afterEach(async () => {
  await server.close();
});

describe('응시자 로그인', () => {
  it('맞는 PIN이면 로그인하고 틀리면 401을 준다', async () => {
    const { candidates } = await prepareOpenExam(server);
    const [first] = candidates;
    const client = new TestClient(server.apps);
    const wrong = await client.request('POST', '/api/candidate/login', { candidateNo: first!.candidateNo, pin: '000000' === first!.pin ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    await client.loginCandidate(first!.candidateNo, first!.pin);
    const state = await client.request<CandidateStateResponse>('GET', '/api/candidate/state');
    expect(state.status).toBe(200);
    expect(state.body.data.candidateNo).toBe(first!.candidateNo);
    expect(state.body.data.cases).toEqual([]);
  });

  it('실패가 한도에 이르면 맞는 PIN도 잠금 시간 동안 거부한다', async () => {
    const { candidates } = await prepareOpenExam(server);
    const target = candidates[0]!;
    const client = new TestClient(server.apps);
    const wrongPin = target.pin === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i += 1) {
      expect((await client.request('POST', '/api/candidate/login', { candidateNo: target.candidateNo, pin: wrongPin })).status).toBe(401);
    }
    const locked = await client.request('POST', '/api/candidate/login', { candidateNo: target.candidateNo, pin: target.pin });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('login_locked');
    server.clock.advanceMinutes(16);
    expect((await client.request('POST', '/api/candidate/login', { candidateNo: target.candidateNo, pin: target.pin })).status).toBe(200);
  });

  it('한 IP의 분당 로그인 시도가 한도를 넘으면 막고, 다른 IP는 영향을 받지 않는다', async () => {
    await server.close();
    server = await createTestServer({ login: { attemptsPerIpPerMinute: 3 } });
    const { candidates } = await prepareOpenExam(server);
    const target = candidates[0]!;
    const flooder = new TestClient(server.apps, '10.0.0.99');
    for (let i = 0; i < 3; i += 1) {
      expect((await flooder.request('POST', '/api/candidate/login', { candidateNo: `NOPE${i}`, pin: '123456' })).status).toBe(401);
    }
    const blocked = await flooder.request('POST', '/api/candidate/login', { candidateNo: target.candidateNo, pin: target.pin });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('login_rate_limited');
    const other = new TestClient(server.apps, '10.0.0.7');
    expect((await other.request('POST', '/api/candidate/login', { candidateNo: target.candidateNo, pin: target.pin })).status).toBe(200);
    server.clock.advanceMinutes(1);
    expect((await flooder.request('POST', '/api/candidate/login', { candidateNo: target.candidateNo, pin: target.pin })).status).toBe(200);
  });

  it('같은 응시번호로 다시 로그인하면 이전 로그인은 끊긴다', async () => {
    const { candidates } = await prepareOpenExam(server);
    const target = candidates[0]!;
    const first = new TestClient(server.apps);
    const second = new TestClient(server.apps);
    await first.loginCandidate(target.candidateNo, target.pin);
    await second.loginCandidate(target.candidateNo, target.pin);
    expect((await first.request('GET', '/api/candidate/state')).status).toBe(401);
    expect((await second.request('GET', '/api/candidate/state')).status).toBe(200);
  });

  it('다른 사이트에서 보낸 상태 변경 요청은 막는다', async () => {
    const { candidates } = await prepareOpenExam(server);
    const client = new TestClient(server.apps);
    const blocked = await client.request('POST', '/api/candidate/login', { candidateNo: candidates[0]!.candidateNo, pin: candidates[0]!.pin }, { origin: 'https://evil.example', host: 'exam.example' });
    expect(blocked.status).toBe(403);
    const blockedBySite = await client.request('POST', '/api/candidate/login', { candidateNo: candidates[0]!.candidateNo, pin: candidates[0]!.pin }, { 'sec-fetch-site': 'cross-site' });
    expect(blockedBySite.status).toBe(403);
  });
});

describe('응시 세션', () => {
  it('시험이 열리기 전에는 시작할 수 없다', async () => {
    const { examId, adminId, candidates } = await prepareOpenExam(server);
    await server.admin.examAdmin.changeStatus(examId, 'closed', adminId);
    const client = new TestClient(server.apps);
    await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
    const result = await client.request('POST', '/api/candidate/session/start');
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('exam_not_open');
  });

  it('관리자 서버가 시험을 열면 수험생 서버가 재시작 없이 곧바로 반영한다(서버마다 캐시가 따로 있다)', async () => {
    const admin = (await server.db.insert(tables.admins).values({ username: 'opener', passwordHash: 'unused' }).returning())[0]!;
    const { examId } = await server.admin.examImport.importDirectory('sample-ai-practice', admin.id);
    const [candidate] = await server.admin.examAdmin.generateCandidates(examId, 'D', 1, admin.id);
    const client = new TestClient(server.apps);
    await client.loginCandidate(candidate!.candidateNo, candidate!.pin);
    // 초안 상태에서 한 번 읽어 수험생 서버 캐시에 시험을 올린다
    expect((await client.request('POST', '/api/candidate/session/start')).body.error.code).toBe('exam_not_open');
    await server.admin.examAdmin.changeStatus(examId, 'open', admin.id);
    expect((await client.request('POST', '/api/candidate/session/start')).status).toBe(201);
  });

  it('시작하면 토큰 원장 첫 행, Case별 대화, 120분 만료 시각이 생기고 두 번 시작할 수 없다', async () => {
    const { candidates } = await prepareOpenExam(server);
    const client = new TestClient(server.apps);
    await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
    const started = await client.request<CandidateStateResponse>('POST', '/api/candidate/session/start');
    expect(started.status).toBe(201);
    const state = started.body.data;
    expect(state.session?.tokenBalance).toBe(40_000);
    expect(new Date(state.session!.expiresAt).getTime() - new Date(state.session!.startedAt).getTime()).toBe(120 * 60_000);
    expect(state.cases.map((c) => c.key)).toEqual(['hr-survey', 'customer-voc', 'travel-expense']);
    expect(state.conversations).toHaveLength(3);
    // 3-5는 공지 전에는 보이지 않는다
    expect(state.cases[2]!.subquestions.map((s) => s.key)).not.toContain('3-5');
    expect((await client.request('POST', '/api/candidate/session/start')).status).toBe(409);
  });

  it('시간이 지나면 쓰기를 막고 마지막 저장본을 최종 제출로 만든다', async () => {
    const { candidates } = await prepareOpenExam(server);
    const client = new TestClient(server.apps);
    await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
    await client.request('POST', '/api/candidate/session/start');
    const saved = await client.request('PUT', '/api/candidate/answers/1-2', { content: { kind: 'text', text: '부서, 직무만족도, 이직의향만 쓴다' } });
    expect(saved.status).toBe(200);

    server.clock.advanceMinutes(121);
    const late = await client.request('PUT', '/api/candidate/answers/1-2', { content: { kind: 'text', text: '늦은 수정' } });
    expect(late.status).toBe(410);

    const answers = await server.db.select().from(tables.answers).orderBy(tables.answers.version);
    expect(answers.map((a) => [a.version, a.isFinal, a.source])).toEqual([
      [1, false, 'candidate_save'],
      [2, true, 'auto_final_on_end'],
    ]);
    const [session] = await server.db.select().from(tables.examSessions);
    expect(session?.status).toBe('expired');
  });

  it('응시자가 제출하면 세션이 끝나고 대화가 닫힌다', async () => {
    const { candidates } = await prepareOpenExam(server);
    const client = new TestClient(server.apps);
    await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
    await client.request('POST', '/api/candidate/session/start');
    const submitted = await client.request<CandidateStateResponse>('POST', '/api/candidate/session/submit');
    expect(submitted.body.data.session?.status).toBe('submitted');
    const conversations = await server.db.select().from(tables.conversations).where(eq(tables.conversations.status, 'active'));
    expect(conversations).toHaveLength(0);
  });

  it('관리자는 진행 중 세션의 시간을 연장할 수 있고 감사 로그가 남는다', async () => {
    const { candidates, adminId } = await prepareOpenExam(server);
    const client = new TestClient(server.apps);
    await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
    const started = await client.request<CandidateStateResponse>('POST', '/api/candidate/session/start');
    const sessionId = started.body.data.session!.id;
    await server.admin.sessionExtension.extend(sessionId, 10, '네트워크 장애', adminId);
    server.clock.advanceMinutes(125);
    expect((await client.request('PUT', '/api/candidate/answers/1-2', { content: { kind: 'text', text: '연장 후 저장' } })).status).toBe(200);
    const audits = await server.db.select().from(tables.auditEvents).where(eq(tables.auditEvents.kind, 'session_extended'));
    expect(audits).toHaveLength(1);
  });
});
