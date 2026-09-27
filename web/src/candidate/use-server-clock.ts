import { useEffect, useMemo, useState } from 'react';

const TICK_MS = 1000;

/**
 * 서버 시각 기준 현재 시각. 응시자 PC 시계를 믿지 않는다(구현계획 4.4).
 * 상태를 받을 때마다 serverNow로 차이를 다시 맞춘다.
 */
export function useServerNow(serverNowIso: string): number {
  const offset = useMemo(() => new Date(serverNowIso).getTime() - Date.now(), [serverNowIso]);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const timer = setInterval(() => setNow(Date.now() + offset), TICK_MS);
    return () => clearInterval(timer);
  }, [offset]);
  return now;
}
