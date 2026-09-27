import { randomUUID } from 'node:crypto';
import { tables, type DatabaseHandle } from '@ai-measurement/infra';
import type { ChatStreamEvent } from '@ai-measurement/shared';
import { eq } from 'drizzle-orm';
import type { Logger } from '../../lib/logger';
import { asTerminalEvent, parseChannelMessage, SNAPSHOT_REQUEST_CHANNEL, streamChannel } from './stream-protocol';

type Listener = (event: ChatStreamEvent) => void;

export interface StreamSubscription {
  snapshot: string;
  unsubscribe: () => void;
}

/** 조각이 빠졌을 때 응시자에게 보이는 안내. 새로고침하면 저장된 응답을 다시 받는다 */
const STREAM_GAP_REASON = '응답을 이어 받는 중 일부가 빠졌습니다. 새로고침하면 저장된 응답을 볼 수 있습니다.';

type SnapshotOutcome = 'snapshot' | 'ended' | 'timeout';

/**
 * 다른 수험생 서버가 맡은 응답을 이 서버의 SSE로 이어 준다.
 * 순서: 대화 채널 LISTEN → 스냅숏 요청 → 맡은 서버가 행에 쓴 스냅숏 읽기 → 이후 조각을 위치(offset)로 이어 붙이기.
 * LISTEN이 요청보다 먼저이므로 스냅숏 이후 조각은 빠지지 않는다. 겹치는 부분은 위치로 잘라 낸다.
 */
export interface RemoteStreamTarget {
  conversationId: string;
  /** 구독을 시작할 때 행에 적힌 담당 서버. 이 서버가 보낸 알림만 받는다(예약을 빼앗긴 옛 담당 서버의 알림은 버린다) */
  ownerInstanceId: string;
}

export async function subscribeRemote(
  handle: Pick<DatabaseHandle, 'db' | 'client'>,
  logger: Logger,
  target: RemoteStreamTarget,
  listener: Listener,
  snapshotTimeoutMs: number,
): Promise<StreamSubscription | null> {
  const { conversationId, ownerInstanceId } = target;
  const requestId = randomUUID();
  const buffered: Array<{ offset: number; text: string }> = [];
  let length: number | null = null;
  let closed = false;
  /** 스냅숏을 읽기 전에 끝 알림이 왔다 */
  let endedBeforeSnapshot = false;
  let signal: (outcome: SnapshotOutcome) => void = () => {};
  const snapshotReady = new Promise<SnapshotOutcome>((resolve) => {
    signal = resolve;
  });

  const listening = await handle.client.listen(streamChannel(conversationId), (payload) => {
    const message = parseChannelMessage(payload);
    if (message === null) {
      logger.error('stream_notification_invalid', { conversationId });
      return;
    }
    if (message.i !== ownerInstanceId) return;
    if (message.k === 's' && message.r === requestId) signal('snapshot');
    else if (message.k === 'd') deliverDelta(message.o, message.t);
    else if (message.k === 'e') {
      if (length !== null) void deliverTerminal();
      else {
        endedBeforeSnapshot = true;
        signal('ended');
      }
    }
  });

  const close = () => {
    if (closed) return;
    closed = true;
    listening.unlisten().catch((error: unknown) => logger.error('stream_unlisten_failed', { conversationId, error }));
  };

  function deliverDelta(offset: number, text: string): void {
    if (closed) return;
    if (length === null) {
      buffered.push({ offset, text });
      return;
    }
    const end = offset + text.length;
    if (end <= length) return;
    if (offset > length) {
      logger.error('stream_gap', { conversationId, expectedOffset: length, receivedOffset: offset });
      listener({ event: 'failed', data: { message: null, reason: STREAM_GAP_REASON } });
      close();
      return;
    }
    listener({ event: 'delta', data: { text: text.slice(length - offset) } });
    length = end;
  }

  async function deliverTerminal(): Promise<void> {
    if (closed) return;
    try {
      const [row] = await handle.db.select({ terminal: tables.aiStreams.terminal }).from(tables.aiStreams).where(eq(tables.aiStreams.conversationId, conversationId));
      const terminal = asTerminalEvent(row?.terminal);
      if (terminal === null) logger.error('stream_terminal_missing', { conversationId });
      // 끝 이벤트가 없으면(보존 시간 경과·새 전송이 예약을 가져감) idle로 끝내 화면이 저장된 대화를 다시 읽게 한다
      listener(terminal ?? { event: 'idle', data: {} });
    } catch (error) {
      logger.error('stream_terminal_read_failed', { conversationId, error });
      listener({ event: 'idle', data: {} });
    } finally {
      close();
    }
  }

  try {
    await handle.client.notify(SNAPSHOT_REQUEST_CHANNEL, JSON.stringify({ c: conversationId, r: requestId }));
    const timer = new Promise<SnapshotOutcome>((resolve) => setTimeout(() => resolve('timeout'), snapshotTimeoutMs).unref());
    const outcome = await Promise.race([snapshotReady, timer]);
    if (outcome !== 'snapshot') {
      if (outcome === 'timeout') logger.error('stream_snapshot_timeout', { conversationId, snapshotTimeoutMs });
      close();
      return null;
    }
    const [row] = await handle.db
      .select({ snapshot: tables.aiStreams.snapshot, instanceId: tables.aiStreams.instanceId })
      .from(tables.aiStreams)
      .where(eq(tables.aiStreams.conversationId, conversationId));
    // 스냅숏이 없거나 그사이 담당 서버가 바뀌었으면 idle로 끝내고 화면이 대화를 다시 읽게 한다
    if (row?.snapshot === null || row?.snapshot === undefined || row.instanceId !== ownerInstanceId) {
      close();
      return null;
    }
    length = row.snapshot.length;
    for (const piece of buffered.splice(0)) deliverDelta(piece.offset, piece.text);
    // 스냅숏 알림과 행 읽기 사이에 끝났으면 끝 이벤트를 이어서 보낸다(구독자는 스냅숏 뒤에 받는다)
    if (endedBeforeSnapshot) void deliverTerminal();
    return { snapshot: row.snapshot, unsubscribe: close };
  } catch (error) {
    close();
    throw error;
  }
}
