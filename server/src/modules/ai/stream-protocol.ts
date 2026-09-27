import type { ChatStreamEvent } from '@ai-measurement/shared';
import { z } from 'zod';

/**
 * 수험생 서버끼리 진행 중인 AI 응답을 나누는 알림 형식(PostgreSQL LISTEN/NOTIFY).
 * 결정: docs/decisions/2026-09-27-수험생-서버-다중-인스턴스.md
 * 알림은 다른 DB 역할도 보낼 수 있으므로 받은 내용은 항상 검증한다. 저장되는 응답은 messages 행이다.
 * 모든 알림에 보낸 서버의 식별자(i)를 넣는다. 예약을 빼앗긴 옛 담당 서버의 알림을 구독자가 걸러 내기 위해서다.
 */

/** 스냅숏 요청 채널. 모든 수험생 서버가 듣고, 응답을 맡은 서버만 답한다 */
export const SNAPSHOT_REQUEST_CHANNEL = 'aim_stream_snapshot_request';

/** NOTIFY 본문 한도는 8000바이트다. 여유를 두고 이보다 크면 조각을 나눈다 */
const MAX_PAYLOAD_BYTES = 7000;

/** 대화 전용 채널. 채널 이름은 63자 이하 식별자여야 하므로 uuid의 하이픈을 뺀다 */
export function streamChannel(conversationId: string): string {
  return `aim_stream_${conversationId.replaceAll('-', '')}`;
}

const instanceIdSchema = z.string().min(1).max(64);

const channelMessageSchema = z.discriminatedUnion('k', [
  /** 응답 조각. o는 전체 텍스트에서 이 조각이 시작하는 위치 */
  z.strictObject({ k: z.literal('d'), i: instanceIdSchema, o: z.number().int().min(0), t: z.string() }),
  /** 스냅숏을 행에 썼다. r은 요청 식별자 */
  z.strictObject({ k: z.literal('s'), i: instanceIdSchema, r: z.uuid() }),
  /** 응답이 끝났다. 끝 이벤트는 행(ai_streams.terminal)에서 읽는다 */
  z.strictObject({ k: z.literal('e'), i: instanceIdSchema }),
]);
export type ChannelMessage = z.infer<typeof channelMessageSchema>;

const snapshotRequestSchema = z.strictObject({ c: z.uuid(), r: z.uuid() });
export type SnapshotRequest = z.infer<typeof snapshotRequestSchema>;

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/** 형식이 틀린 알림이면 null. 호출자가 기록하고 버린다 */
export function parseChannelMessage(payload: string): ChannelMessage | null {
  const parsed = channelMessageSchema.safeParse(parseJson(payload));
  return parsed.success ? parsed.data : null;
}

export function parseSnapshotRequest(payload: string): SnapshotRequest | null {
  const parsed = snapshotRequestSchema.safeParse(parseJson(payload));
  return parsed.success ? parsed.data : null;
}

/** 조각 하나를 알림 한도에 맞게 나눠 인코딩한다. 한국어·이스케이프 문자 때문에 글자 수가 아니라 바이트로 잰다 */
export function encodeDelta(instanceId: string, offset: number, text: string): string[] {
  const payload = JSON.stringify({ k: 'd', i: instanceId, o: offset, t: text } satisfies ChannelMessage);
  if (Buffer.byteLength(payload, 'utf8') <= MAX_PAYLOAD_BYTES || text.length <= 1) return [payload];
  const half = Math.ceil(text.length / 2);
  return [...encodeDelta(instanceId, offset, text.slice(0, half)), ...encodeDelta(instanceId, offset + half, text.slice(half))];
}

export function encodeSnapshotReady(instanceId: string, requestId: string): string {
  return JSON.stringify({ k: 's', i: instanceId, r: requestId } satisfies ChannelMessage);
}

export function encodeEnd(instanceId: string): string {
  return JSON.stringify({ k: 'e', i: instanceId } satisfies ChannelMessage);
}

export type TerminalEvent = Extract<ChatStreamEvent, { event: 'done' } | { event: 'failed' }>;

/** ai_streams.terminal에서 읽은 값. 우리 서버가 쓴 값이지만 형식을 확인한 뒤 쓴다 */
export function asTerminalEvent(value: unknown): TerminalEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const event = (value as { event?: unknown }).event;
  const data = (value as { data?: unknown }).data;
  if ((event === 'done' || event === 'failed') && typeof data === 'object' && data !== null) return value as TerminalEvent;
  return null;
}
