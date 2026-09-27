export function formatNumber(value: number): string {
  return value.toLocaleString('ko-KR');
}

/** 남은 시간 표시 HH:MM:SS */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { hour12: false });
}

/** 시작 시각 기준 경과 시간 T+HH:MM:SS */
export function formatElapsed(fromIso: string, atIso: string): string {
  return `T+${formatRemaining(new Date(atIso).getTime() - new Date(fromIso).getTime())}`;
}

export function formatScore(value: number | null): string {
  return value === null ? '미채점' : value.toFixed(1);
}
