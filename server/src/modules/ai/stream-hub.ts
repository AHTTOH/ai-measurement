import { randomUUID } from 'node:crypto';
import { tables, type DatabaseHandle } from '@ai-measurement/infra';
import type { ChatStreamEvent } from '@ai-measurement/shared';
import { and, eq, gte, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { ephemeralWrite } from '../../lib/ephemeral-write';
import type { Logger } from '../../lib/logger';
import { subscribeRemote, type StreamSubscription } from './remote-stream-subscription';
import { encodeDelta, encodeEnd, encodeSnapshotReady, parseSnapshotRequest, SNAPSHOT_REQUEST_CHANNEL, streamChannel, type TerminalEvent } from './stream-protocol';

type Listener = (event: ChatStreamEvent) => void;

export type { StreamSubscription } from './remote-stream-subscription';

export interface StreamHubTiming {
  /** 맡은 응답 행의 생존 시각을 갱신하는 간격 */
  heartbeatMs: number;
  /** 이 시간 동안 생존 시각이 갱신되지 않은 예약은 버려진 것으로 본다(서버가 죽음) */
  staleMs: number;
  /** 응답 조각을 모아 다른 서버에 알리는 간격 */
  notifyIntervalMs: number;
  /** 다른 서버에 스냅숏을 요청하고 기다리는 시간 */
  snapshotTimeoutMs: number;
  /** 끝난 응답 행(끝 이벤트)을 남겨 두는 시간 */
  finishedRetentionMs: number;
}

interface LocalStream {
  text: string;
  started: boolean;
  listeners: Set<Listener>;
  /**
   * 다른 서버가 이 응답의 스냅숏을 요청한 적이 있다. 그 전에는 조각을 알리지 않는다(알림 커밋은 전역 잠금을 거쳐 비싸다).
   * 요청 시점까지의 텍스트는 스냅숏에 모두 들어가므로 빠지는 조각이 없다
   */
  watchedRemotely: boolean;
  /** 아직 다른 서버에 알리지 않은 조각과 그 시작 위치. pendingOffset + pending.length === text.length */
  pending: string;
  pendingOffset: number;
  flushTimer: NodeJS.Timeout | null;
  /** 알림을 순서대로 보내는 사슬 */
  outbox: Promise<void>;
  /** 끝내는 중. 이때 온 스냅숏 요청은 받지 않는다(구독자는 끝 알림을 받는다) */
  finishing: boolean;
  /** 예약한 시각(이 서버 시계). 생존 표시 갱신과 겹친 새 예약을 '잃은 예약'으로 오인하지 않기 위해 쓴다 */
  reservedAtMs: number;
}

/**
 * 진행 중인 AI 응답을 대화별로 조정한다(결정: docs/decisions/2026-09-27-수험생-서버-다중-인스턴스.md).
 * - 예약: ai_streams 행 INSERT 한 번. 대화 하나에 동시에 하나의 응답만 허용한다(여러 서버 전체에서)
 * - 같은 서버의 구독자: 메모리로 바로 받는다
 * - 다른 서버의 구독자: LISTEN/NOTIFY로 스냅숏과 조각을 받는다(remote-stream-subscription.ts)
 * 응시자가 새로고침해도 서버 쪽 응답은 끝까지 진행되고, 다시 연결하면 지금까지의 텍스트부터 이어 받는다.
 */
export class StreamHub {
  readonly instanceId = randomUUID();
  private readonly local = new Map<string, LocalStream>();
  private heartbeat: NodeJS.Timeout | null = null;
  private snapshotRequests: { unlisten: () => Promise<void> } | null = null;

  constructor(
    private readonly handle: Pick<DatabaseHandle, 'db' | 'client'>,
    private readonly timing: StreamHubTiming,
    private readonly logger: Logger,
  ) {}

  /** 다른 서버의 스냅숏 요청을 듣고, 생존 시각 갱신을 시작한다. 요청을 받기 전에 부른다 */
  async start(): Promise<void> {
    this.snapshotRequests = await this.handle.client.listen(SNAPSHOT_REQUEST_CHANNEL, (payload) => this.onSnapshotRequest(payload));
    this.heartbeat = setInterval(() => void this.beat(), this.timing.heartbeatMs);
    this.heartbeat.unref();
  }

  async stop(): Promise<void> {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const stream of this.local.values()) if (stream.flushTimer !== null) clearTimeout(stream.flushTimer);
    const listening = this.snapshotRequests;
    this.snapshotRequests = null;
    if (listening !== null) await listening.unlisten();
  }

  /** 대화 하나에 동시에 하나의 요청만 허용한다. 다른 서버 것까지 포함해 살아 있는 예약이 있으면 false */
  async tryReserve(conversationId: string): Promise<boolean> {
    if (this.local.has(conversationId)) return false;
    const now = sql`now()`;
    const rows = await ephemeralWrite(this.handle.db, (tx) =>
      tx
        .insert(tables.aiStreams)
        .values({ conversationId, instanceId: this.instanceId, reservedAt: now, heartbeatAt: now })
        .onConflictDoUpdate({
          target: tables.aiStreams.conversationId,
          set: { instanceId: this.instanceId, reservedAt: now, heartbeatAt: now, snapshot: null, terminal: null, finishedAt: null },
          setWhere: or(isNotNull(tables.aiStreams.finishedAt), lt(tables.aiStreams.heartbeatAt, this.staleBefore())),
        })
        .returning({ conversationId: tables.aiStreams.conversationId }),
    );
    if (rows.length === 0 || this.local.has(conversationId)) return false;
    this.local.set(conversationId, {
      text: '',
      started: false,
      listeners: new Set(),
      watchedRemotely: false,
      pending: '',
      pendingOffset: 0,
      flushTimer: null,
      outbox: Promise.resolve(),
      finishing: false,
      reservedAtMs: Date.now(),
    });
    return true;
  }

  /** 응답을 시작하기 전에 실패했을 때 예약을 푼다 */
  async release(conversationId: string): Promise<void> {
    const stream = this.local.get(conversationId);
    if (stream === undefined || stream.started) return;
    this.local.delete(conversationId);
    await ephemeralWrite(this.handle.db, (tx) =>
      tx
        .delete(tables.aiStreams)
        .where(and(eq(tables.aiStreams.conversationId, conversationId), eq(tables.aiStreams.instanceId, this.instanceId), isNull(tables.aiStreams.finishedAt))),
    );
  }

  begin(conversationId: string): void {
    const stream = this.local.get(conversationId);
    if (stream === undefined) throw new Error(`예약하지 않은 대화의 응답을 시작할 수 없습니다: ${conversationId}`);
    stream.started = true;
  }

  /** 이 서버나 다른 서버에서 응답이 진행 중인가 */
  async isBusy(conversationId: string): Promise<boolean> {
    if (this.local.has(conversationId)) return true;
    const [row] = await this.handle.db
      .select({ conversationId: tables.aiStreams.conversationId })
      .from(tables.aiStreams)
      .where(and(eq(tables.aiStreams.conversationId, conversationId), this.liveCondition()))
      .limit(1);
    return row !== undefined;
  }

  append(conversationId: string, delta: string): void {
    const stream = this.local.get(conversationId);
    if (stream === undefined) return;
    stream.text += delta;
    stream.pending += delta;
    for (const listener of stream.listeners) listener({ event: 'delta', data: { text: delta } });
    if (stream.watchedRemotely && stream.flushTimer === null) stream.flushTimer = setTimeout(() => this.flush(conversationId, stream), this.timing.notifyIntervalMs);
  }

  /**
   * 응답을 끝낸다. 남은 조각을 알리고, 끝 이벤트를 행에 쓰고, 이 서버의 구독자에게 보내고, 다른 서버에 알린다.
   * 백그라운드 응답 처리에서 부르므로 DB 오류는 던지지 않고 기록한다(이 서버의 구독자는 그래도 끝 이벤트를 받는다).
   */
  async finish(conversationId: string, event: TerminalEvent): Promise<void> {
    const stream = this.local.get(conversationId);
    if (stream === undefined) return;
    stream.finishing = true;
    this.flush(conversationId, stream);
    await stream.outbox;
    let owned = false;
    try {
      const rows = await ephemeralWrite(this.handle.db, (tx) =>
        tx
          .update(tables.aiStreams)
          .set({ terminal: event, finishedAt: sql`now()`, snapshot: null })
          .where(and(eq(tables.aiStreams.conversationId, conversationId), eq(tables.aiStreams.instanceId, this.instanceId)))
          .returning({ conversationId: tables.aiStreams.conversationId }),
      );
      owned = rows.length > 0;
      // 예약을 다른 서버가 가져갔다(이 서버가 멈춘 것처럼 보였음). 그 서버의 구독자에게 끝 알림을 보내면 안 된다
      if (!owned) this.logger.error('stream_reservation_lost', { conversationId, at: 'finish' });
    } catch (error) {
      this.logger.error('stream_finish_record_failed', { conversationId, error });
    }
    this.local.delete(conversationId);
    for (const listener of stream.listeners) listener(event);
    if (!owned) return;
    try {
      await this.handle.client.notify(streamChannel(conversationId), encodeEnd(this.instanceId));
    } catch (error) {
      this.logger.error('stream_finish_notify_failed', { conversationId, error });
    }
  }

  /**
   * 진행 중이면 지금까지의 텍스트를, 아니면 null을 돌려준다(짧은 요청으로 반복해서 읽는 화면용).
   * 다른 서버가 맡은 응답이면 스냅숏을 한 번 받아 오고 바로 구독을 푼다.
   */
  async progress(conversationId: string): Promise<string | null> {
    const stream = this.local.get(conversationId);
    if (stream !== undefined) return stream.text;
    const subscription = await this.subscribe(conversationId, () => {});
    if (subscription === null) return null;
    subscription.unsubscribe();
    return subscription.snapshot;
  }

  /** 진행 중이면 지금까지의 텍스트와 구독 해제 함수를, 아니면 null을 돌려준다 */
  async subscribe(conversationId: string, listener: Listener): Promise<StreamSubscription | null> {
    const stream = this.local.get(conversationId);
    if (stream !== undefined) {
      stream.listeners.add(listener);
      return { snapshot: stream.text, unsubscribe: () => stream.listeners.delete(listener) };
    }
    const [row] = await this.handle.db
      .select({ instanceId: tables.aiStreams.instanceId })
      .from(tables.aiStreams)
      .where(and(eq(tables.aiStreams.conversationId, conversationId), ne(tables.aiStreams.instanceId, this.instanceId), this.liveCondition()))
      .limit(1);
    if (row === undefined) return null;
    return subscribeRemote(this.handle, this.logger, { conversationId, ownerInstanceId: row.instanceId }, listener, this.timing.snapshotTimeoutMs);
  }

  private flush(conversationId: string, stream: LocalStream): void {
    if (stream.flushTimer !== null) clearTimeout(stream.flushTimer);
    stream.flushTimer = null;
    if (stream.pending === '') return;
    const payloads = encodeDelta(this.instanceId, stream.pendingOffset, stream.pending);
    stream.pendingOffset = stream.text.length;
    stream.pending = '';
    // 원격 구독자가 없으면 버린다. 나중에 붙는 구독자는 스냅숏으로 받는다
    if (!stream.watchedRemotely) return;
    this.enqueue(conversationId, stream, async () => {
      for (const payload of payloads) await this.handle.client.notify(streamChannel(conversationId), payload);
    });
  }

  private enqueue(conversationId: string, stream: LocalStream, task: () => Promise<void>): void {
    stream.outbox = stream.outbox.then(task).catch((error: unknown) => this.logger.error('stream_notify_failed', { conversationId, error }));
  }

  /** 다른 서버가 이 서버가 맡은 응답의 스냅숏을 요청했다. 알림 순서를 지키도록 조각 알림과 같은 사슬에 넣는다 */
  private onSnapshotRequest(payload: string): void {
    const request = parseSnapshotRequest(payload);
    if (request === null) {
      this.logger.error('stream_snapshot_request_invalid', {});
      return;
    }
    const stream = this.local.get(request.c);
    if (stream === undefined || stream.finishing) return;
    stream.watchedRemotely = true;
    this.enqueue(request.c, stream, async () => {
      // 스냅숏에 지금까지의 텍스트가 모두 들어가므로, 아직 알리지 않은 조각은 따로 알릴 필요가 없다
      if (stream.flushTimer !== null) clearTimeout(stream.flushTimer);
      stream.flushTimer = null;
      stream.pendingOffset = stream.text.length;
      stream.pending = '';
      const snapshot = stream.text;
      const rows = await ephemeralWrite(this.handle.db, (tx) =>
        tx
          .update(tables.aiStreams)
          .set({ snapshot })
          .where(and(eq(tables.aiStreams.conversationId, request.c), eq(tables.aiStreams.instanceId, this.instanceId), isNull(tables.aiStreams.finishedAt)))
          .returning({ conversationId: tables.aiStreams.conversationId }),
      );
      if (rows.length === 0) {
        if (!stream.finishing) this.abandon(request.c, stream, 'snapshot');
        return;
      }
      await this.handle.client.notify(streamChannel(request.c), encodeSnapshotReady(this.instanceId, request.r));
    });
  }

  /**
   * 예약을 다른 서버가 가져갔다(이 서버가 한동안 멈춘 것처럼 보였다). 더는 알림을 보내지 않고 손을 뗀다.
   * 이 서버에 붙은 구독자는 idle을 받아 저장된 대화를 다시 읽는다. 응답 생성은 채팅 서비스가 끝까지 진행해 저장한다.
   */
  private abandon(conversationId: string, stream: LocalStream, at: string): void {
    if (this.local.get(conversationId) !== stream) return;
    this.logger.error('stream_reservation_lost', { conversationId, at });
    if (stream.flushTimer !== null) clearTimeout(stream.flushTimer);
    stream.flushTimer = null;
    this.local.delete(conversationId);
    for (const listener of stream.listeners) listener({ event: 'idle', data: {} });
  }

  /** 이 서버가 맡은 응답의 생존 시각을 갱신하고, 예약을 잃은 응답에서 손을 떼고, 오래된 행을 지운다 */
  private async beat(): Promise<void> {
    const beatStartedAt = Date.now();
    try {
      const owned = await ephemeralWrite(this.handle.db, async (tx) => {
        const rows = await tx
          .update(tables.aiStreams)
          .set({ heartbeatAt: sql`now()` })
          .where(and(eq(tables.aiStreams.instanceId, this.instanceId), isNull(tables.aiStreams.finishedAt)))
          .returning({ conversationId: tables.aiStreams.conversationId });
        await tx
          .delete(tables.aiStreams)
          .where(
            or(
              lt(tables.aiStreams.finishedAt, sql`now() - make_interval(secs => ${this.timing.finishedRetentionMs / 1000})`),
              lt(tables.aiStreams.heartbeatAt, sql`now() - make_interval(secs => ${(this.timing.staleMs + this.timing.finishedRetentionMs) / 1000})`),
            ),
          );
        return new Set(rows.map((r) => r.conversationId));
      });
      for (const [conversationId, stream] of this.local) {
        // 갱신 쿼리와 겹쳐 새로 예약한 것, 끝내는 중인 것은 건너뛴다
        if (stream.reservedAtMs >= beatStartedAt || stream.finishing || owned.has(conversationId)) continue;
        this.abandon(conversationId, stream, 'heartbeat');
      }
    } catch (error) {
      this.logger.error('stream_heartbeat_failed', { error });
    }
  }

  private staleBefore() {
    return sql`now() - make_interval(secs => ${this.timing.staleMs / 1000})`;
  }

  /** 끝나지 않았고 맡은 서버가 살아 있는 예약 */
  private liveCondition() {
    return and(isNull(tables.aiStreams.finishedAt), gte(tables.aiStreams.heartbeatAt, this.staleBefore()));
  }
}
