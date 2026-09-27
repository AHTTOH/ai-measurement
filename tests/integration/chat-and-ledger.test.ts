import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tables } from '@ai-measurement/infra';
import type { CandidateStateResponse, ConversationDetailResponse, SendMessageResponse } from '@ai-measurement/shared';
import { asc, eq } from 'drizzle-orm';
import { createTestServer, prepareOpenExam, TestClient, waitForResponse, type TestServer } from './support/test-server';

let server: TestServer;
let client: TestClient;
let state: CandidateStateResponse;

function conversationOf(caseKey: string): string {
  const conversation = state.conversations.find((c) => c.caseKey === caseKey && c.status === 'active');
  if (conversation === undefined) throw new Error(`${caseKey} 대화가 없습니다`);
  return conversation.id;
}

async function send(conversationId: string, body: Partial<{ text: string; attachments: unknown[]; subquestionKey: string | null; clientMessageId: string }>) {
  return client.request<SendMessageResponse>('POST', `/api/candidate/conversations/${conversationId}/messages`, {
    clientMessageId: body.clientMessageId ?? randomUUID(),
    subquestionKey: body.subquestionKey ?? null,
    text: body.text ?? '',
    attachments: body.attachments ?? [],
  });
}

async function startAs(serverToUse: TestServer): Promise<void> {
  const { candidates } = await prepareOpenExam(serverToUse);
  client = new TestClient(serverToUse.apps);
  await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
  state = (await client.request<CandidateStateResponse>('POST', '/api/candidate/session/start')).body.data;
}

describe('AI 채팅과 토큰 원장', () => {
  beforeEach(async () => {
    server = await createTestServer();
    await startAs(server);
  });
  afterEach(async () => {
    await server.close();
  });

  it('보낸 메시지만큼 차감하고 AI 응답을 저장한다', async () => {
    const conversationId = conversationOf('hr-survey');
    const sent = await send(conversationId, { text: '부서별 평균을 구하는 방법을 알려줘', subquestionKey: '1-3' });
    expect(sent.status).toBe(201);
    expect(sent.body.data.charged).toBeGreaterThan(0);
    expect(sent.body.data.tokenBalance).toBe(40_000 - sent.body.data.charged);
    await waitForResponse(server.candidate, conversationId);

    const detail = await client.request<ConversationDetailResponse>('GET', `/api/candidate/conversations/${conversationId}`);
    expect(detail.body.data.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.body.data.messages[1]!.text).toContain('[모의 AI 응답]');
    expect(detail.body.data.messages[1]!.provider).toBe('mock');

    const ledger = await server.db.select().from(tables.tokenLedger).orderBy(asc(tables.tokenLedger.id));
    expect(ledger.map((l) => [l.reason, l.delta])).toEqual([
      ['initial', 40_000],
      ['message', -sent.body.data.charged],
    ]);
  });

  it('CSV는 고른 컬럼·행만 보내고, 보낸 본문을 첨부 기록에 남긴다', async () => {
    const conversationId = conversationOf('hr-survey');
    const sent = await send(conversationId, {
      text: '부서별 평균 직무만족도를 계산해줘',
      attachments: [{ kind: 'csv', materialKey: 'employees', columns: ['부서', '직무만족도', '이직의향'], rowIndexes: [0, 1, 2] }],
    });
    expect(sent.status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    const [attachment] = await server.db.select().from(tables.attachments);
    expect(attachment?.selection).toEqual({ kind: 'csv', columns: ['부서', '직무만족도', '이직의향'], rowIndexes: [0, 1, 2] });
    expect(attachment?.renderedText).toContain('부서,직무만족도,이직의향');
    expect(attachment?.renderedText).not.toContain('주민등록번호');
    expect(attachment?.renderedText?.split('\n').filter((l) => l.length > 0)).toHaveLength(5); // 머리말 + 헤더 + 3행
  });

  it('PDF는 고른 페이지만 새 PDF로 만들어 저장하고, 다음 요청에도 같은 바이트를 다시 보낸다', async () => {
    const conversationId = conversationOf('travel-expense');
    const sent = await send(conversationId, { text: '한도 표를 요약해줘', attachments: [{ kind: 'pdf', materialKey: 'travel-policy', pageFrom: 2, pageTo: 2 }] });
    expect(sent.status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    const [blob] = await server.db.select().from(tables.attachmentBlobs);
    expect(blob?.bytes.subarray(0, 5).toString()).toBe('%PDF-');

    const second = await send(conversationId, { text: '고마워' });
    expect(second.status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    const users = await server.db.select().from(tables.messages).where(eq(tables.messages.role, 'user')).orderBy(asc(tables.messages.seq));
    // 두 번째 요청의 전체 컨텍스트는 첫 요청 PDF까지 포함하므로 차감량보다 훨씬 크다
    expect(users[1]!.contextTokens!).toBeGreaterThan(users[1]!.chargedTokens! + users[0]!.chargedTokens!);
  });

  it('남은 토큰이 모자라면 보내지 않고 아무것도 기록하지 않는다', async () => {
    const conversationId = conversationOf('customer-voc');
    const huge = '가'.repeat(100_000); // 모의 환산 50,000토큰 이상
    const result = await send(conversationId, { text: huge });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('insufficient_tokens');
    expect(await server.db.select().from(tables.messages)).toHaveLength(0);
    expect(await server.candidate.hub.isBusy(conversationId)).toBe(false);
  });

  it('같은 clientMessageId는 두 번 받지 않는다', async () => {
    const conversationId = conversationOf('hr-survey');
    const id = randomUUID();
    expect((await send(conversationId, { text: '첫 요청', clientMessageId: id })).status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    const again = await send(conversationId, { text: '첫 요청', clientMessageId: id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('duplicate_message');
  });

  it('AI가 답하는 중에는 같은 대화에 다시 보낼 수 없다', async () => {
    await server.close();
    const { MockGateway } = await import('@ai-measurement/server');
    server = await createTestServer({ ai: new MockGateway({ chunkDelayMs: 30 }) });
    await startAs(server);
    const conversationId = conversationOf('hr-survey');
    expect((await send(conversationId, { text: '긴 답변 부탁' })).status).toBe(201);
    const blocked = await send(conversationId, { text: '또 보냄' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('response_in_progress');
    await waitForResponse(server.candidate, conversationId);
  });

  it('여러 Case로 동시에 보내도 잔액이 음수가 되지 않는다', async () => {
    const text = '나'.repeat(30_000); // 모의 환산 약 15,000토큰. 40,000 예산으로 두 건만 가능
    const results = await Promise.all(
      ['hr-survey', 'customer-voc', 'travel-expense'].map((caseKey) => send(conversationOf(caseKey), { text })),
    );
    const accepted = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(accepted).toHaveLength(2);
    expect(rejected[0]?.body.error.code).toBe('insufficient_tokens');
    for (const caseKey of ['hr-survey', 'customer-voc', 'travel-expense']) await waitForResponse(server.candidate, conversationOf(caseKey));
    const ledger = await server.db.select().from(tables.tokenLedger).orderBy(asc(tables.tokenLedger.id));
    expect(Math.min(...ledger.map((l) => l.balanceAfter))).toBeGreaterThanOrEqual(0);
  });

  it('대화가 컨텍스트 상한을 넘으면 새 대화를 안내하고, 새 대화에서는 다시 보낼 수 있다', async () => {
    await server.close();
    server = await createTestServer();
    await startAs(server);
    // 정의를 바꾸고 등록 시각도 바꿔 재등록처럼 만든다. 수험생 서버 캐시는 등록 시각이 바뀌면 다시 읽는다
    const [exam] = await server.db.select().from(tables.exams);
    await server.db.update(tables.exams).set({ definition: { ...exam!.definition, contextTokenLimit: 3_000 }, importedAt: new Date(exam!.importedAt.getTime() + 1) });
    const conversationId = conversationOf('hr-survey');
    expect((await send(conversationId, { text: '다'.repeat(4_000) })).status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    const overflow = await send(conversationId, { text: '라'.repeat(2_000) });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error.code).toBe('context_limit_exceeded');

    const created = await client.request<{ id: string }>('POST', '/api/candidate/conversations', { caseKey: 'hr-survey' });
    expect(created.status).toBe(201);
    expect((await send(created.body.data.id, { text: '라'.repeat(2_000) })).status).toBe(201);
    await waitForResponse(server.candidate, created.body.data.id);
    const old = await client.request('POST', `/api/candidate/conversations/${conversationId}/messages`, { clientMessageId: randomUUID(), subquestionKey: null, text: 'x', attachments: [] });
    expect(old.body.error.code).toBe('conversation_closed');
  });

  it('본문의 개인정보 패턴을 메시지에 기록한다(전송은 막지 않는다)', async () => {
    const conversationId = conversationOf('customer-voc');
    expect((await send(conversationId, { text: '고객 010-1234-5678 에게 연락해야 해' })).status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    const [message] = await server.db.select().from(tables.messages).where(eq(tables.messages.role, 'user'));
    expect(message?.patternHits).toEqual([{ patternId: 'mobile', count: 1 }]);
  });

  it('다른 응시자의 대화는 볼 수 없다', async () => {
    const conversationId = conversationOf('hr-survey');
    const { candidates } = await (async () => {
      const rows = await server.admin.examAdmin.generateCandidates((await server.db.select().from(tables.exams))[0]!.id, 'X', 1, (await server.db.select().from(tables.admins))[0]!.id);
      return { candidates: rows };
    })();
    const other = new TestClient(server.apps);
    await other.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
    expect((await other.request('GET', `/api/candidate/conversations/${conversationId}`)).status).toBe(404);
  });
});
