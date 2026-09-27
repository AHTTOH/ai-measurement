import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tables } from '@ai-measurement/infra';
import type { CandidateStateResponse, SaveAnswerResponse } from '@ai-measurement/shared';
import { asc, eq } from 'drizzle-orm';
import { createTestServer, prepareOpenExam, TestClient, type TestServer } from './support/test-server';

let server: TestServer;
let client: TestClient;

beforeEach(async () => {
  server = await createTestServer();
  const { candidates } = await prepareOpenExam(server);
  client = new TestClient(server.apps);
  await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
  await client.request('POST', '/api/candidate/session/start');
});
afterEach(async () => {
  await server.close();
});

const text = (value: string) => ({ content: { kind: 'text', text: value } });

describe('답안 저장·제출', () => {
  it('저장할 때마다 버전이 늘고, 내용이 같으면 늘지 않는다', async () => {
    await client.request('PUT', '/api/candidate/answers/1-2', text('초안'));
    await client.request('PUT', '/api/candidate/answers/1-2', text('초안'));
    const second = await client.request<SaveAnswerResponse>('PUT', '/api/candidate/answers/1-2', text('수정본'));
    expect(second.body.data.answer.version).toBe(2);
    const submitted = await client.request<SaveAnswerResponse>('POST', '/api/candidate/answers/1-2/submit', text('수정본'));
    expect(submitted.body.data.answer.version).toBe(3);
    expect(submitted.body.data.answer.latestIsFinal).toBe(true);
    const rows = await server.db.select().from(tables.answers).orderBy(asc(tables.answers.version));
    expect(rows.map((r) => [r.version, r.source])).toEqual([
      [1, 'candidate_save'],
      [2, 'candidate_save'],
      [3, 'candidate_submit'],
    ]);
  });

  it('형식이 다른 답안과 없는 선택지를 거부한다', async () => {
    expect((await client.request('PUT', '/api/candidate/answers/1-1', text('서술'))).status).toBe(400);
    expect((await client.request('PUT', '/api/candidate/answers/1-1', { content: { kind: 'multi_choice', selected: ['nope'] } })).status).toBe(400);
    expect((await client.request('PUT', '/api/candidate/answers/1-1', { content: { kind: 'multi_choice', selected: ['name', 'rrn'] } })).status).toBe(200);
  });
});

describe('진행 중 조건 변경(공지)', () => {
  it('1-3을 제출하면 개인정보 공지가 열리고 감사 로그에 한 번만 남는다', async () => {
    const saved = await client.request<SaveAnswerResponse>('POST', '/api/candidate/answers/1-3/submit', text('부서별 표'));
    expect(saved.body.data.newlyRevealedNotices.map((n) => n.key)).toEqual(['privacy-small-org']);
    const state = await client.request<CandidateStateResponse>('GET', '/api/candidate/state');
    expect(state.body.data.cases[0]!.notices.map((n) => n.key)).toEqual(['privacy-small-org']);
    await client.request<SaveAnswerResponse>('POST', '/api/candidate/answers/1-3/submit', text('수정한 표'));
    const logged = await server.db.select().from(tables.auditEvents).where(eq(tables.auditEvents.kind, 'notice_revealed'));
    expect(logged).toHaveLength(1);
  });

  it('3-5는 시작 60분 뒤 공지와 함께 열리고, 그전에는 답안을 받지 않는다', async () => {
    const locked = await client.request('PUT', '/api/candidate/answers/3-5', text('미리 씀'));
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('subquestion_locked');
    server.clock.advanceMinutes(60);
    const state = await client.request<CandidateStateResponse>('GET', '/api/candidate/state');
    const travel = state.body.data.cases.find((c) => c.key === 'travel-expense')!;
    expect(travel.subquestions.map((s) => s.key)).toContain('3-5');
    expect(travel.notices[0]?.key).toBe('overseas-per-diem-change');
    expect((await client.request('PUT', '/api/candidate/answers/3-5', text('새 기준 재검토'))).status).toBe(200);
  });

  it('하위문항 진입·이탈과 탭 전환을 기록한다', async () => {
    expect((await client.request('POST', '/api/candidate/events', { kind: 'subquestion_enter', subquestionKey: '1-1' })).status).toBe(200);
    expect((await client.request('POST', '/api/candidate/events', { kind: 'tab_hidden', subquestionKey: null })).status).toBe(200);
    expect((await client.request('POST', '/api/candidate/events', { kind: 'subquestion_enter', subquestionKey: 'no-such' })).status).toBe(404);
    expect(await server.db.select().from(tables.clientEvents)).toHaveLength(2);
  });
});
