/** 자원 상태 색 단계(화면 설계: 색은 자원 상태의 의미로만 쓴다) */
export type ResourceLevel = 'ok' | 'caution' | 'danger';

/** 남은 토큰 비율이 이 값 미만이면 주의·위험 */
const TOKEN_CAUTION_RATIO = 0.5;
const TOKEN_DANGER_RATIO = 0.2;
/** 남은 시간(분)이 이 값 미만이면 주의·위험 */
const TIME_CAUTION_MINUTES = 30;
const TIME_DANGER_MINUTES = 10;

export function tokenLevel(balance: number, budget: number): ResourceLevel {
  const ratio = budget > 0 ? balance / budget : 0;
  if (ratio < TOKEN_DANGER_RATIO) return 'danger';
  if (ratio < TOKEN_CAUTION_RATIO) return 'caution';
  return 'ok';
}

export function timeLevel(remainingMs: number): ResourceLevel {
  const minutes = remainingMs / 60_000;
  if (minutes < TIME_DANGER_MINUTES) return 'danger';
  if (minutes < TIME_CAUTION_MINUTES) return 'caution';
  return 'ok';
}
