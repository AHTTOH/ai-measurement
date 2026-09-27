/** 샘플 시험 자료를 매번 같은 값으로 만들기 위한 시드 고정 난수(mulberry32) */
export interface SeededRandom {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  digits(count: number): string;
}

export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error('빈 목록에서 고를 수 없습니다');
      return item;
    },
    chance: (probability: number) => next() < probability,
    digits: (count: number) => Array.from({ length: count }, () => String(int(0, 9))).join(''),
  };
}
