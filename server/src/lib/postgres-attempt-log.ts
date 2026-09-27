import { tables, type Database } from '@ai-measurement/infra';
import { and, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { AttemptLog } from './attempt-log';
import { ephemeralWrite } from './ephemeral-write';

/** 집계 쿼리는 항상 한 행을 돌려준다. 없으면 드라이버·DB 이상이므로 0으로 메우지 않는다 */
function single(rows: Array<{ n: number }>): number {
  const [row] = rows;
  if (row === undefined) throw new Error('집계 결과가 비어 있습니다(rate_limit_hits)');
  return row.n;
}

/**
 * PostgreSQL 구현(rate_limit_hits). 수험생 서버 여러 대가 같은 한도를 나눠 쓴다.
 * 시각은 서버 시계(Clock)를 쓴다. 테스트의 가짜 시계와 한도 계산이 맞아야 하기 때문이다.
 */
export class PostgresAttemptLog implements AttemptLog {
  constructor(private readonly db: Database) {}

  /**
   * 세기와 기록을 DB 함수 한 번으로 한다(마이그레이션 0005). 함수 안에서 버킷 잠금을 잡으므로 여러 서버가 동시에 불러도
   * 한도를 넘지 않고, 잠금은 DB 안에서만 잠깐 잡혀 서버와의 왕복을 기다리지 않는다.
   */
  async recordIfUnder(bucket: string, since: Date, at: Date, limit: number): Promise<boolean> {
    const result = await this.db.execute<{ acquired: boolean }>(
      sql`SELECT rate_limit_try_acquire(${bucket}, ${since.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz, ${limit}) AS acquired`,
    );
    const [row] = result;
    if (row === undefined) throw new Error('rate_limit_try_acquire 결과가 비어 있습니다');
    return row.acquired;
  }

  /** 기록과 세기를 DB 함수 한 번으로 한다(마이그레이션 0006). 여러 서버가 동시에 기록해도 서로의 기록을 센다 */
  async recordAndCount(bucket: string, at: Date, since: Date): Promise<number> {
    const [row] = await this.db.execute<{ recent: number }>(
      sql`SELECT rate_limit_record_and_count(${bucket}, ${since.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz) AS recent`,
    );
    if (row === undefined) throw new Error('rate_limit_record_and_count 결과가 비어 있습니다');
    return Number(row.recent);
  }

  async record(bucket: string, at: Date): Promise<void> {
    await ephemeralWrite(this.db, (tx) => tx.insert(tables.rateLimitHits).values({ bucket, at }));
  }

  async count(bucket: string, since: Date): Promise<number> {
    return single(
      await this.db
        .select({ n: count() })
        .from(tables.rateLimitHits)
        .where(and(eq(tables.rateLimitHits.bucket, bucket), gt(tables.rateLimitHits.at, since))),
    );
  }

  async latest(bucket: string, since: Date): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: tables.rateLimitHits.at })
      .from(tables.rateLimitHits)
      .where(and(eq(tables.rateLimitHits.bucket, bucket), gt(tables.rateLimitHits.at, since)))
      .orderBy(desc(tables.rateLimitHits.at))
      .limit(1);
    return row?.at ?? null;
  }

  async clear(bucket: string): Promise<void> {
    // 로그인 성공마다 부르고 대개 지울 행이 없다. 쓰기가 없으면 커밋이 디스크를 기다리지 않으므로 한 문장으로 한다
    await this.db.delete(tables.rateLimitHits).where(eq(tables.rateLimitHits.bucket, bucket));
  }

  async prune(before: Date): Promise<void> {
    await ephemeralWrite(this.db, (tx) => tx.delete(tables.rateLimitHits).where(lt(tables.rateLimitHits.at, before)));
  }
}
