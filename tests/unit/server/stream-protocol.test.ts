import { describe, expect, it } from 'vitest';
import {
  asTerminalEvent,
  encodeDelta,
  parseChannelMessage,
  parseSnapshotRequest,
  SNAPSHOT_REQUEST_CHANNEL,
  streamChannel,
} from '../../../server/src/modules/ai/stream-protocol';

/** 알림을 보낸 서버 식별자(2026-09-27부터 모든 알림에 들어간다) */
const INSTANCE_ID = 'instance-under-test';

/** PostgreSQL NOTIFY 본문 한도(바이트) */
const NOTIFY_LIMIT_BYTES = 8000;
const CONVERSATION_ID = '3f2b8c1e-9a4d-4e7b-8c6f-1d2e3a4b5c6d';
const REQUEST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** 인코딩한 조각을 모두 해석해 오프셋 순서로 이어 붙인다. 각 조각은 앞 조각이 끝난 자리에서 시작해야 한다 */
function reassemble(payloads: readonly string[], startOffset: number): string {
  const deltas = payloads.map((payload) => {
    const message = parseChannelMessage(payload);
    if (message === null || message.k !== 'd') throw new Error(`조각이 아닌 알림입니다: ${payload}`);
    return message;
  });
  const ordered = [...deltas].sort((a, b) => a.o - b.o);
  let text = '';
  for (const delta of ordered) {
    expect(delta.o).toBe(startOffset + text.length);
    text += delta.t;
  }
  return text;
}

describe('스트림 채널 이름', () => {
  it('uuid 하이픈을 빼서 63자 이하 식별자로 만든다', () => {
    const channel = streamChannel(CONVERSATION_ID);

    expect(channel).toBe('aim_stream_3f2b8c1e9a4d4e7b8c6f1d2e3a4b5c6d');
    expect(channel.length).toBeLessThanOrEqual(63);
    expect(channel).toMatch(/^[a-z0-9_]+$/u);
  });

  it('스냅숏 요청 채널은 대화 채널과 겹치지 않는 고정 이름이다', () => {
    expect(SNAPSHOT_REQUEST_CHANNEL).toBe('aim_stream_snapshot_request');
    expect(SNAPSHOT_REQUEST_CHANNEL).not.toBe(streamChannel(CONVERSATION_ID));
  });
});

describe('채널 알림 해석', () => {
  it.each([
    ['조각', { k: 'd', i: INSTANCE_ID, o: 0, t: '안녕' }],
    ['빈 조각', { k: 'd', i: INSTANCE_ID, o: 12, t: '' }],
    ['스냅숏 완료', { k: 's', i: INSTANCE_ID, r: REQUEST_ID }],
    ['응답 끝', { k: 'e', i: INSTANCE_ID }],
  ])('%s 알림을 그대로 돌려준다', (_label, message) => {
    expect(parseChannelMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    ['JSON이 아닌 본문', '{not json'],
    ['빈 본문', ''],
    ['null', 'null'],
    ['배열', '[1,2]'],
    ['문자열', '"d"'],
    ['모르는 종류', JSON.stringify({ k: 'x' })],
    ['종류 없음', JSON.stringify({ o: 0, t: 'a' })],
    ['음수 오프셋', JSON.stringify({ k: 'd', i: INSTANCE_ID, o: -1, t: 'a' })],
    ['정수가 아닌 오프셋', JSON.stringify({ k: 'd', i: INSTANCE_ID, o: 1.5, t: 'a' })],
    ['문자열 오프셋', JSON.stringify({ k: 'd', i: INSTANCE_ID, o: '0', t: 'a' })],
    ['텍스트 없음', JSON.stringify({ k: 'd', i: INSTANCE_ID, o: 0 })],
    ['모르는 필드가 붙은 조각', JSON.stringify({ k: 'd', i: INSTANCE_ID, o: 0, t: 'a', extra: true })],
    ['uuid가 아닌 요청 식별자', JSON.stringify({ k: 's', i: INSTANCE_ID, r: 'not-a-uuid' })],
    ['서버 식별자가 없는 조각', JSON.stringify({ k: 'd', o: 0, t: 'a' })],
    ['모르는 필드가 붙은 끝 알림', JSON.stringify({ k: 'e', i: INSTANCE_ID, terminal: {} })],
  ])('%s는 null로 버린다', (_label, payload) => {
    expect(parseChannelMessage(payload)).toBeNull();
  });
});

describe('스냅숏 요청 해석', () => {
  it('대화 id와 요청 id가 모두 uuid면 받아들인다', () => {
    const request = { c: CONVERSATION_ID, r: REQUEST_ID };

    expect(parseSnapshotRequest(JSON.stringify(request))).toEqual(request);
  });

  it.each([
    ['JSON이 아닌 본문', 'c=1&r=2'],
    ['요청 id 없음', JSON.stringify({ c: CONVERSATION_ID })],
    ['대화 id가 uuid가 아님', JSON.stringify({ c: 'conversation', r: REQUEST_ID })],
    ['모르는 필드', JSON.stringify({ c: CONVERSATION_ID, r: REQUEST_ID, x: 1 })],
    ['객체가 아님', JSON.stringify([CONVERSATION_ID, REQUEST_ID])],
  ])('%s는 null로 버린다', (_label, payload) => {
    expect(parseSnapshotRequest(payload)).toBeNull();
  });
});

describe('조각 인코딩', () => {
  it('짧은 조각은 알림 하나로 만든다', () => {
    // Act
    const payloads = encodeDelta(INSTANCE_ID, 5, '짧은 응답');

    // Assert
    expect(payloads).toHaveLength(1);
    expect(parseChannelMessage(payloads[0] ?? '')).toEqual({ k: 'd', i: INSTANCE_ID, o: 5, t: '짧은 응답' });
  });

  it.each([
    ['긴 영문', 'abcdefghij'.repeat(2_000)],
    ['긴 한국어(글자당 3바이트)', '가나다라마바사아자차'.repeat(900)],
    ['이스케이프가 필요한 제어 문자·따옴표', '\u0001"\\\n'.repeat(3_000)],
    ['서로게이트 쌍이 섞인 이모지', 'a😀'.repeat(4_000)],
  ])('%s는 한도 안의 조각으로 나누고, 오프셋대로 이으면 원문이 된다', (_label, text) => {
    // Arrange
    const startOffset = 17;

    // Act
    const payloads = encodeDelta(INSTANCE_ID, startOffset, text);

    // Assert
    expect(payloads.length).toBeGreaterThan(1);
    for (const payload of payloads) {
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(NOTIFY_LIMIT_BYTES);
    }
    expect(parseChannelMessage(payloads[0] ?? '')).toMatchObject({ k: 'd', i: INSTANCE_ID, o: startOffset });
    expect(reassemble([...payloads].reverse(), startOffset)).toBe(text);
  });

  it('한 글자짜리 조각은 더 나누지 않는다', () => {
    expect(encodeDelta(INSTANCE_ID, 0, '가')).toEqual([JSON.stringify({ k: 'd', i: INSTANCE_ID, o: 0, t: '가' })]);
    expect(encodeDelta(INSTANCE_ID, 0, '')).toEqual([JSON.stringify({ k: 'd', i: INSTANCE_ID, o: 0, t: '' })]);
  });
});

describe('끝 이벤트 확인', () => {
  it('done·failed 이벤트에 data 객체가 있으면 그대로 돌려준다', () => {
    const done = { event: 'done', data: { message: { id: 'm1' } } };
    const failed = { event: 'failed', data: { message: null, reason: 'AI 오류' } };

    expect(asTerminalEvent(done)).toBe(done);
    expect(asTerminalEvent(failed)).toBe(failed);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['문자열', 'done'],
    ['숫자', 1],
    ['이벤트 없음', { data: {} }],
    ['끝이 아닌 이벤트', { event: 'delta', data: { text: 'a' } }],
    ['data 없음', { event: 'done' }],
    ['data가 null', { event: 'failed', data: null }],
    ['data가 문자열', { event: 'done', data: 'message' }],
  ])('%s는 null이다', (_label, value) => {
    expect(asTerminalEvent(value)).toBeNull();
  });
});
