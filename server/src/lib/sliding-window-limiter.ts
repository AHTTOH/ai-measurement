import type { AttemptLog } from './attempt-log';
import type { Clock } from './clock';

/** 키별로 최근 windowMs 안의 요청 수를 제한한다. 기록은 AttemptLog에 둔다(여러 서버가 나눠 쓸 수 있다) */
export class SlidingWindowLimiter {
  constructor(
    private readonly log: AttemptLog,
    private readonly clock: Clock,
    /** 버킷 이름 앞에 붙여 다른 한도와 섞이지 않게 한다 */
    private readonly scope: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 허용되면 기록하고 true, 한도를 넘으면 false */
  tryAcquire(key: string): Promise<boolean> {
    const now = this.clock.now();
    return this.log.recordIfUnder(`${this.scope}:${key}`, new Date(now.getTime() - this.windowMs), now, this.limit);
  }
}
