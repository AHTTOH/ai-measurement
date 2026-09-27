import type { ChatStreamEvent } from '@ai-measurement/shared';
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { StreamHub } from '../modules/ai/stream-hub';

/** 프록시가 유휴 연결을 끊지 않도록 보내는 ping 간격 */
const PING_INTERVAL_MS = 15_000;

function write(stream: SSEStreamingApi, event: ChatStreamEvent): Promise<void> {
  return stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
}

/**
 * 진행 중인 AI 응답을 SSE로 이어 준다. 먼저 지금까지의 텍스트(snapshot)를 보내고,
 * 이후 조각(delta)을 보내다가 done 또는 failed에서 끝낸다. 진행 중인 응답이 없으면 idle 하나만 보낸다.
 * 다른 서버가 맡은 응답의 끝 이벤트를 읽지 못하면 idle로 끝낸다. 화면은 idle을 받으면 저장된 대화를 다시 읽는다.
 */
export function chatStreamResponse(c: Context, hub: StreamHub, conversationId: string): Response {
  return streamSSE(c, async (stream) => {
    const queue: ChatStreamEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: ChatStreamEvent) => {
      queue.push(event);
      wake?.();
    };
    const subscription = await hub.subscribe(conversationId, push);
    if (subscription === null) {
      await write(stream, { event: 'idle', data: {} });
      return;
    }
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      wake?.();
    });
    const ping = setInterval(() => push({ event: 'ping', data: {} }), PING_INTERVAL_MS);
    try {
      await write(stream, { event: 'snapshot', data: { text: subscription.snapshot } });
      while (!aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
        for (let event = queue.shift(); event !== undefined; event = queue.shift()) {
          await write(stream, event);
          if (event.event === 'done' || event.event === 'failed' || event.event === 'idle') return;
        }
      }
    } finally {
      clearInterval(ping);
      subscription.unsubscribe();
    }
  });
}
