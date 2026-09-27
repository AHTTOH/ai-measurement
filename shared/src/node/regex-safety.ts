import { check } from 'recheck';

/** 정규식 하나를 분석하는 최대 시간. 넘으면 '판정 불가'로 보고 등록을 막는다 */
const RECHECK_TIMEOUT_MS = 10_000;
const cache = new Map<string, string | null>();

/**
 * 탐지 정규식이 재앙적 역추적(ReDoS)을 일으킬 수 있는지 등록 전에 검사한다.
 * 개인정보 탐지 패턴은 응시자 메시지(최대 20만 자)마다 서버에서 돌기 때문에, 위험한 패턴 하나가 시험 전체를 멈출 수 있다.
 * 안전하면 null, 아니면 사유를 돌려준다.
 */
export async function unsafeRegexReason(source: string): Promise<string | null> {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  // Java·네이티브 바이너리를 찾지 않고 순수 JS 워커 스레드로 검사한다(검사 중에도 서버 이벤트 루프를 막지 않는다)
  process.env['RECHECK_BACKEND'] = 'worker';
  const result = await check(source, 'gu', { timeout: RECHECK_TIMEOUT_MS });
  let reason: string | null;
  if (result.status === 'safe') {
    reason = null;
  } else if (result.status === 'vulnerable') {
    reason = `재앙적 역추적(ReDoS) 위험이 있는 정규식입니다(${result.complexity.type === 'exponential' ? '지수' : '다항식'} 시간). 반복에 상한을 두고 시작 경계를 고정하십시오`;
  } else {
    reason = `정규식의 안전성을 판정하지 못했습니다(${result.error.kind}). 더 단순한 형태로 바꾸십시오`;
  }
  cache.set(source, reason);
  return reason;
}
