import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tables } from '@ai-measurement/infra';
import { MockGateway } from '@ai-measurement/server';
import type { ChatMessageView, SendMessageResponse } from '@ai-measurement/shared';
import { and, eq } from 'drizzle-orm';
import {
  createCandidateInstance,
  createTestServer,
  prepareOpenExam,
  readSse,
  TestClient,
  waitForResponse,
  type CandidateInstance,
  type TestServer,
} from './support/test-server';

/**
 * 수험생 서버 여러 대(결정: docs/decisions/2026-09-27-수험생-서버-다중-인스턴스.md).
 * 같은 DB에 수험생 서버 두 벌(A, B)을 띄운다. 연결 풀·스트림 허브·서비스가 따로다.
 */
/** 모의 응답이 2~3초 흘러나오게 해 다른 서버가 중간에 붙을 시간을 넉넉히 둔다(1초면 느린 첫 실행에서 응답이 먼저 끝나 idle이 된 적이 있다, 2026-09-27) */
const SLOW_CHUNK_MS = 100;

let server: TestServer;
let instanceB: CandidateInstance;
let clientA: TestClient;
let clientB: TestClient;
let conversationId: string;
let login: { candidateNo: string; pin: string };

async function setUp(options: { aiRequestsPerMinute?: number; heartbeatMs?: number } = {}): Promise<void> {
  server = await createTestServer({
    ai: new MockGateway({ chunkDelayMs: SLOW_CHUNK_MS }),
    streamTiming: options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {},
    candidateConfig: options.aiRequestsPerMinute !== undefined ? { candidateAiRequestsPerMinute: options.aiRequestsPerMinute } : {},
  });
  instanceB = await createCandidateInstance(server, { ai: new MockGateway({ chunkDelayMs: SLOW_CHUNK_MS }) });
  const { candidates } = await prepareOpenExam(server, 1);
  login = candidates[0]!;
  clientA = new TestClient(server.apps);
  clientB = clientA.via({ candidate: instanceB.app, admin: server.apps.admin });
  await clientA.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
  expect((await clientB.request('POST', '/api/candidate/session/start')).status).toBe(201);
  const [conversation] = await server.db.select().from(tables.conversations).where(eq(tables.conversations.caseKey, 'hr-survey'));
  conversationId = conversation!.id;
}

function send(client: TestClient, text: string) {
  return client.request<SendMessageResponse>('POST', `/api/candidate/conversations/${conversationId}/messages`, { clientMessageId: randomUUID(), subquestionKey: null, text, attachments: [] });
}

afterEach(async () => {
  await instanceB.close();
  await server.close();
});

describe('응답 스트림', () => {
  beforeEach(async () => {
    await setUp();
  });

  it('A가 맡은 응답을 B의 SSE가 스냅숏·조각·끝까지 이어 받는다', async () => {
    expect((await send(clientA, '다른 서버에서 이어 받기')).status).toBe(201);
    // 응답이 흐르는 중에 B가 진행 여부를 안다
    const detail = await clientB.request<{ streaming: boolean }>('GET', `/api/candidate/conversations/${conversationId}`);
    expect(detail.body.data.streaming).toBe(true);

    const events = await readSse(await clientB.raw('GET', `/api/candidate/conversations/${conversationId}/stream`));
    expect(events[0]?.event).toBe('snapshot');
    const last = events.at(-1)!;
    expect(last.event).toBe('done');
    const received = events
      .filter((e) => e.event === 'snapshot' || e.event === 'delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    const final = (last.data as { message: ChatMessageView }).message;
    expect(received).toBe(final.text);
    expect(final.role).toBe('assistant');
    expect(await instanceB.services.hub.isBusy(conversationId)).toBe(false);
  });

  it('진행 확인(/progress)은 다른 서버가 맡은 응답의 지금까지 텍스트를 주고, 끝나면 streaming=false다', async () => {
    expect((await send(clientA, '진행 확인')).status).toBe(201);
    const during = await clientB.request<{ streaming: boolean; text: string | null }>('GET', `/api/candidate/conversations/${conversationId}/progress`);
    expect(during.status).toBe(200);
    expect(during.body.data.streaming).toBe(true);
    expect(typeof during.body.data.text).toBe('string');
    await waitForResponse(server.candidate, conversationId);
    const after = await clientB.request<{ streaming: boolean; text: string | null }>('GET', `/api/candidate/conversations/${conversationId}/progress`);
    expect(after.body.data).toEqual({ streaming: false, text: null });
    const [saved] = await server.db.select().from(tables.messages).where(and(eq(tables.messages.conversationId, conversationId), eq(tables.messages.role, 'assistant')));
    expect(saved?.plainText.startsWith(during.body.data.text ?? '')).toBe(true);
  });

  it('응답이 끝난 뒤 다른 서버에 붙으면 idle을 받는다', async () => {
    expect((await send(clientA, '짧게')).status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    const events = await readSse(await clientB.raw('GET', `/api/candidate/conversations/${conversationId}/stream`));
    expect(events.map((e) => e.event)).toEqual(['idle']);
  });

  it('두 서버에서 같은 대화로 거의 동시에 보내도 하나만 받는다', async () => {
    const [fromA, fromB] = await Promise.all([send(clientA, '동시 전송 A'), send(clientB, '동시 전송 B')]);
    expect([fromA.status, fromB.status].sort()).toEqual([201, 409]);
    const rejected = fromA.status === 409 ? fromA : fromB;
    expect(rejected.body.error.code).toBe('response_in_progress');
    await waitForResponse(server.candidate, conversationId);
    // 거부된 전송은 토큰을 차감하지 않았다
    const charges = await server.db.select().from(tables.tokenLedger).where(eq(tables.tokenLedger.reason, 'message'));
    expect(charges).toHaveLength(1);
  });

  it('응답을 맡은 서버가 죽어 생존 표시가 끊긴 예약은 다른 서버가 가져간다', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await server.db.insert(tables.aiStreams).values({ conversationId, instanceId: 'dead-instance', reservedAt: past, heartbeatAt: past });
    expect(await instanceB.services.hub.isBusy(conversationId)).toBe(false);
    expect((await send(clientB, '이어서 보내기')).status).toBe(201);
    await waitForResponse(instanceB.services, conversationId);
    const [row] = await server.db.select().from(tables.aiStreams).where(eq(tables.aiStreams.conversationId, conversationId));
    expect(row?.instanceId).toBe(instanceB.services.hub.instanceId);
    expect(row?.finishedAt).not.toBeNull();
  });
});

describe('예약을 빼앗긴 서버', () => {
  it('자기 예약이 다른 서버로 넘어간 것을 알면 손을 떼고 붙어 있던 구독자에게 idle을 보낸다', async () => {
    await setUp({ heartbeatMs: 100 });
    expect((await send(clientA, '느린 응답')).status).toBe(201);
    const stream = clientA.raw('GET', `/api/candidate/conversations/${conversationId}/stream`);
    // A가 멈춘 것처럼 보여 다른 서버가 예약을 가져간 상황을 만든다
    await server.db.update(tables.aiStreams).set({ instanceId: 'usurper-instance' }).where(eq(tables.aiStreams.conversationId, conversationId));
    const events = await readSse(await stream);
    expect(events.at(-1)?.event).toBe('idle');
    // A의 응답 생성은 끝까지 가서 저장된다. 빼앗은 쪽 예약이 살아 있으므로 '진행 중 아님'이 아니라 저장을 기다린다
    const deadline = Date.now() + 10_000;
    while ((await server.db.select().from(tables.messages).where(and(eq(tables.messages.conversationId, conversationId), eq(tables.messages.role, 'assistant')))).length === 0) {
      if (Date.now() > deadline) throw new Error('A의 응답이 저장되지 않았습니다');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A는 끝낼 때 새 담당 서버의 행을 건드리지 않는다
    const [row] = await server.db.select().from(tables.aiStreams).where(eq(tables.aiStreams.conversationId, conversationId));
    expect(row?.instanceId).toBe('usurper-instance');
    expect(row?.terminal).toBeNull();
  });
});

describe('한도와 잠금은 서버 전체에서 센다', () => {
  it('AI 요청 한도를 두 서버가 나눠 쓴다', async () => {
    await setUp({ aiRequestsPerMinute: 2 });
    expect((await send(clientA, '첫 번째')).status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    expect((await send(clientB, '두 번째')).status).toBe(201);
    await waitForResponse(instanceB.services, conversationId);
    const third = await send(clientA, '세 번째');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('ai_rate_limited');
    server.clock.advanceMinutes(1);
    expect((await send(clientB, '1분 뒤')).status).toBe(201);
    await waitForResponse(instanceB.services, conversationId);
  });

  it('로그인 실패를 두 서버에서 합쳐 세어 잠근다', async () => {
    await setUp();
    const wrongPin = login.pin === '000000' ? '111111' : '000000';
    const maxFailures = server.candidate.config.login.maxFailures;
    for (let i = 0; i < maxFailures; i += 1) {
      const client = i % 2 === 0 ? clientA : clientB;
      expect((await client.request('POST', '/api/candidate/login', { candidateNo: login.candidateNo, pin: wrongPin })).status).toBe(401);
    }
    // 맞는 PIN이어도 잠금 동안은 거부한다
    const locked = await clientB.request('POST', '/api/candidate/login', login);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('login_locked');
    const lockRows = await server.db.select().from(tables.rateLimitHits).where(eq(tables.rateLimitHits.bucket, `login-lock:candidate:${login.candidateNo}`));
    expect(lockRows).toHaveLength(1);
  });
});
