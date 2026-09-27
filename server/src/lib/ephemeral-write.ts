import type { Database, Transaction } from '@ai-measurement/infra';
import { sql } from 'drizzle-orm';

/**
 * 조정용 임시 상태(요청 한도 기록, 응답 스트림 예약)를 쓸 때 커밋이 디스크 기록(WAL flush)을 기다리지 않게 한다.
 * 다른 연결에 보이는 시점은 같고, DB가 갑자기 꺼질 때 마지막 몇 건이 사라질 수 있을 뿐이다. 이 상태는 잃어도 되는 값이다.
 * 대화·원장·답안 같은 기록에는 쓰지 않는다. 2026-09-27 부하 테스트에서 커밋 대기가 연결 풀을 막는 것을 확인했다.
 */
export function ephemeralWrite<T>(db: Database, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL synchronous_commit TO OFF`);
    return work(tx);
  });
}
