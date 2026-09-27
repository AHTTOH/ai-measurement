import type { Clock } from './clock';

/**
 * 시각이 찍힌 시도 기록(요청 한도, 로그인 실패·잠금). 버킷 이름으로 나눈다.
 * 수험생 서버는 여러 대가 함께 쓰도록 PostgreSQL 구현을, 관리자 서버는 메모리 구현을 쓴다
 * (결정: docs/decisions/2026-09-27-수험생-서버-다중-인스턴스.md).
 */
export interface AttemptLog {
  /** since보다 뒤(since 자체는 제외)의 기록이 limit보다 적으면 at으로 하나 기록하고 true. 세기와 기록은 원자적이다 */
  recordIfUnder(bucket: string, since: Date, at: Date, limit: number): Promise<boolean>;
  record(bucket: string, at: Date): Promise<void>;
  /** at으로 하나 기록하고 since보다 뒤의 기록 수(방금 것 포함)를 돌려준다. 기록과 세기는 원자적이다 */
  recordAndCount(bucket: string, at: Date, since: Date): Promise<number>;
  count(bucket: string, since: Date): Promise<number>;
  /** since 이후 가장 최근 기록 시각. 없으면 null */
  latest(bucket: string, since: Date): Promise<Date | null>;
  clear(bucket: string): Promise<void>;
  /** before보다 오래된 기록을 모두 지운다 */
  prune(before: Date): Promise<void>;
}

/** 키가 이만큼 쌓이면 보존 기간을 넘은 기록을 정리한다(임의 키로 맵을 키우는 공격 방지) */
const PRUNE_THRESHOLD = 5_000;

/** 프로세스 메모리 구현. 한 대만 띄우는 관리자 서버용 */
export class MemoryAttemptLog implements AttemptLog {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    /** 이보다 오래된 기록은 정리 대상이다. 가장 긴 창보다 길게 둔다 */
    private readonly retentionMs: number,
  ) {}

  async recordIfUnder(bucket: string, since: Date, at: Date, limit: number): Promise<boolean> {
    if ((await this.count(bucket, since)) >= limit) return false;
    await this.record(bucket, at);
    return true;
  }

  async record(bucket: string, at: Date): Promise<void> {
    this.hits.set(bucket, [...(this.hits.get(bucket) ?? []), at.getTime()]);
    if (this.hits.size > PRUNE_THRESHOLD) await this.prune(new Date(this.clock.now().getTime() - this.retentionMs));
  }

  async recordAndCount(bucket: string, at: Date, since: Date): Promise<number> {
    await this.record(bucket, at);
    return this.count(bucket, since);
  }

  async count(bucket: string, since: Date): Promise<number> {
    return (this.hits.get(bucket) ?? []).filter((t) => t > since.getTime()).length;
  }

  async latest(bucket: string, since: Date): Promise<Date | null> {
    const recent = (this.hits.get(bucket) ?? []).filter((t) => t > since.getTime());
    return recent.length === 0 ? null : new Date(Math.max(...recent));
  }

  async clear(bucket: string): Promise<void> {
    this.hits.delete(bucket);
  }

  async prune(before: Date): Promise<void> {
    for (const [bucket, times] of this.hits) {
      const kept = times.filter((t) => t >= before.getTime());
      if (kept.length === 0) this.hits.delete(bucket);
      else this.hits.set(bucket, kept);
    }
  }
}
