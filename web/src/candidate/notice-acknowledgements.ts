/**
 * 공지 '확인' 표시는 응시자 브라우저에만 남기는 편의 기능이다(채점과 무관, 노출 시각은 서버가 기록한다).
 * 저장소를 쓸 수 없는 환경이면 이번 화면에서만 기억한다.
 */
const memory = new Set<string>();

function storageKey(sessionId: string): string {
  return `aim:notice-ack:${sessionId}`;
}

export function loadAcknowledged(sessionId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set([...memory, ...(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])]);
  } catch {
    return new Set(memory);
  }
}

export function acknowledge(sessionId: string, noticeKey: string): Set<string> {
  memory.add(noticeKey);
  const next = loadAcknowledged(sessionId);
  next.add(noticeKey);
  try {
    window.localStorage.setItem(storageKey(sessionId), JSON.stringify([...next]));
  } catch {
    // 저장소를 못 쓰면 memory에만 남긴다(이번 화면 동안 유지)
  }
  return next;
}
