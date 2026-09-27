import { describe, expect, it } from 'vitest';
import { MemoryAttemptLog } from '../../../server/src/lib/attempt-log';
import type { Clock } from '../../../server/src/lib/clock';

const NOW_MS = Date.UTC(2026, 8, 27, 9, 0, 0);
const RETENTION_MS = 60_000;
/** 메모리 구현이 스스로 정리를 시작하는 버킷 수(attempt-log.ts의 PRUNE_THRESHOLD) */
const AUTO_PRUNE_BUCKETS = 5_000;

const fixedClock: Clock = { now: () => new Date(NOW_MS) };

function at(offsetMs: number): Date {
  return new Date(NOW_MS + offsetMs);
}

function newLog(): MemoryAttemptLog {
  return new MemoryAttemptLog(fixedClock, RETENTION_MS);
}

describe('메모리 시도 기록: 한도 안에서만 기록', () => {
  it('창 안의 기록이 한도보다 적을 때만 기록하고 true를 돌려준다', async () => {
    // Arrange
    const log = newLog();
    const since = at(-60_000);

    // Act
    const results = [
      await log.recordIfUnder('ip:1', since, at(-3), 2),
      await log.recordIfUnder('ip:1', since, at(-2), 2),
      await log.recordIfUnder('ip:1', since, at(-1), 2),
    ];

    // Assert
    expect(results).toEqual([true, true, false]);
    expect(await log.count('ip:1', since)).toBe(2);
  });

  it('한도가 0이면 처음부터 기록하지 않는다', async () => {
    const log = newLog();

    expect(await log.recordIfUnder('ip:1', at(-1_000), at(0), 0)).toBe(false);
    expect(await log.count('ip:1', at(-1_000))).toBe(0);
  });

  it('창이 지나 오래된 기록이 빠지면 다시 기록할 수 있다', async () => {
    // Arrange
    const log = newLog();
    await log.record('ip:1', at(-50_000));

    // Act
    const insideOldWindow = await log.recordIfUnder('ip:1', at(-60_000), at(-10), 1);
    const afterWindowMoved = await log.recordIfUnder('ip:1', at(-40_000), at(0), 1);

    // Assert
    expect(insideOldWindow).toBe(false);
    expect(afterWindowMoved).toBe(true);
  });

  it('버킷끼리 서로 세지 않는다', async () => {
    const log = newLog();
    await log.record('login:alice', at(-1));

    expect(await log.recordIfUnder('login:bob', at(-1_000), at(0), 1)).toBe(true);
    expect(await log.count('login:alice', at(-1_000))).toBe(1);
  });
});

describe('메모리 시도 기록: 창 경계', () => {
  it('since와 같은 시각의 기록은 세지 않는다(since 초과만 센다)', async () => {
    // Arrange
    const log = newLog();
    const boundary = at(-30_000);
    await log.record('ip:1', boundary);

    // Act
    const atBoundary = await log.count('ip:1', boundary);
    const justBefore = await log.count('ip:1', new Date(boundary.getTime() - 1));

    // Assert
    expect(atBoundary).toBe(0);
    expect(justBefore).toBe(1);
  });

  it('경계에 걸친 기록은 recordIfUnder의 한도 계산에서도 빠진다', async () => {
    const log = newLog();
    const boundary = at(-30_000);
    await log.record('ip:1', boundary);

    expect(await log.recordIfUnder('ip:1', boundary, at(0), 1)).toBe(true);
  });

  it('latest도 since와 같은 시각의 기록은 제외한다', async () => {
    const log = newLog();
    const boundary = at(-30_000);
    await log.record('ip:1', boundary);

    expect(await log.latest('ip:1', boundary)).toBeNull();
  });
});

describe('메모리 시도 기록: 최근 시각과 삭제', () => {
  it('latest는 창 안 기록 중 가장 늦은 시각을 돌려준다(기록 순서와 무관)', async () => {
    // Arrange
    const log = newLog();
    await log.record('ip:1', at(-5_000));
    await log.record('ip:1', at(-1_000));
    await log.record('ip:1', at(-3_000));

    // Act
    const latest = await log.latest('ip:1', at(-10_000));

    // Assert
    expect(latest).toEqual(at(-1_000));
  });

  it('기록이 없는 버킷의 latest와 count는 null과 0이다', async () => {
    const log = newLog();

    expect(await log.latest('none', at(-10_000))).toBeNull();
    expect(await log.count('none', at(-10_000))).toBe(0);
  });

  it('clear는 그 버킷만 지운다', async () => {
    // Arrange
    const log = newLog();
    await log.record('login:alice', at(-1));
    await log.record('login:bob', at(-1));

    // Act
    await log.clear('login:alice');

    // Assert
    expect(await log.count('login:alice', at(-1_000))).toBe(0);
    expect(await log.count('login:bob', at(-1_000))).toBe(1);
  });

  it('prune은 before보다 오래된 기록만 지우고 before와 같은 시각은 남긴다', async () => {
    // Arrange
    const log = newLog();
    const before = at(-20_000);
    await log.record('ip:1', at(-30_000));
    await log.record('ip:1', before);
    await log.record('ip:1', at(-10_000));
    await log.record('ip:2', at(-25_000));

    // Act
    await log.prune(before);

    // Assert
    const everything = new Date(0);
    expect(await log.count('ip:1', everything)).toBe(2);
    expect(await log.latest('ip:1', everything)).toEqual(at(-10_000));
    expect(await log.count('ip:2', everything)).toBe(0);
  });
});

describe('메모리 시도 기록: 자동 정리', () => {
  it('버킷이 한도를 넘으면 보존 기간이 지난 기록을 스스로 지운다', async () => {
    // Arrange
    const log = newLog();
    const everything = new Date(0);
    const expired = at(-RETENTION_MS - 1);
    await log.record('keep:recent', at(-1));
    for (let i = 1; i < AUTO_PRUNE_BUCKETS; i += 1) {
      await log.record(`old:${i}`, expired);
    }
    const beforeOverflow = await log.count('old:1', everything);

    // Act
    await log.record('trigger', at(0));

    // Assert
    expect(beforeOverflow).toBe(1);
    expect(await log.count('old:1', everything)).toBe(0);
    expect(await log.count(`old:${AUTO_PRUNE_BUCKETS - 1}`, everything)).toBe(0);
    expect(await log.count('keep:recent', everything)).toBe(1);
    expect(await log.count('trigger', everything)).toBe(1);
  });

  it('보존 기간 경계(now - retention)와 같은 시각의 기록은 자동 정리에서도 남긴다', async () => {
    // Arrange
    const log = newLog();
    const everything = new Date(0);
    const edge = at(-RETENTION_MS);
    for (let i = 0; i < AUTO_PRUNE_BUCKETS; i += 1) {
      await log.record(`edge:${i}`, edge);
    }

    // Act
    await log.record('trigger', at(0));

    // Assert
    expect(await log.count('edge:0', everything)).toBe(1);
    expect(await log.count(`edge:${AUTO_PRUNE_BUCKETS - 1}`, everything)).toBe(1);
  });
});
