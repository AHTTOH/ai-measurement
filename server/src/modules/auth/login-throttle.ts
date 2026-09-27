import type { AttemptLog } from '../../lib/attempt-log';
import { appErrors } from '../../lib/app-error';
import { MS_PER_MINUTE, type Clock } from '../../lib/clock';
import { SlidingWindowLimiter } from '../../lib/sliding-window-limiter';

export interface LoginThrottleSettings {
  maxFailures: number;
  lockMinutes: number;
  /** 한 IP에서 1분에 받을 로그인 시도 수. 시험장 전체가 한 IP를 쓸 수 있으므로 응시 인원보다 넉넉히 둔다 */
  attemptsPerIpPerMinute: number;
}

/** 기록 보존 기간. 가장 긴 창(잠금 시간, IP 창 1분)보다 길어야 한다 */
export function loginAttemptRetentionMs(settings: LoginThrottleSettings): number {
  return Math.max(settings.lockMinutes, 1) * MS_PER_MINUTE;
}

/**
 * 로그인 무차별 대입·과부하 방지.
 * - 계정(응시번호·관리자 아이디)별: 최근 lockMinutes 안에 maxFailures번 실패하면 그때부터 lockMinutes 동안 잠근다.
 *   기록은 accountLog에 둔다. 수험생 서버는 DB에 두어 여러 대가 같은 잠금을 본다(여러 서버로 나눠 시도해도 막힌다)
 * - IP별: 1분 시도 수 상한. 로그인마다 비싼 해시 계산이 도는 이 서버의 CPU를 지키는 한도이므로 서버마다 따로 센다(ipLog, 메모리).
 *   시험장 전체가 한 IP로 들어오면 모든 로그인이 한 버킷을 쓰는데, DB에 두면 버킷 잠금에 줄지어 기다린다
 *   (2026-09-27 부하 테스트: 120건 동시 처리 879ms, 서버별 메모리로 바꿔 해소)
 */
export class LoginThrottle {
  private readonly perIp: SlidingWindowLimiter;

  constructor(
    private readonly accountLog: AttemptLog,
    ipLog: AttemptLog,
    private readonly clock: Clock,
    private readonly settings: LoginThrottleSettings,
  ) {
    this.perIp = new SlidingWindowLimiter(ipLog, clock, 'login-ip', settings.attemptsPerIpPerMinute, MS_PER_MINUTE);
  }

  /** 시도를 기록하고, IP 한도를 넘었거나 계정이 잠겼으면 429를 던진다 */
  async assertAllowed(accountKey: string, clientAddress: string): Promise<void> {
    if (!(await this.perIp.tryAcquire(clientAddress))) {
      throw appErrors.tooManyRequests('login_rate_limited', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하십시오');
    }
    const now = this.clock.now().getTime();
    const lockedAt = await this.accountLog.latest(lockBucket(accountKey), new Date(now - this.lockMs));
    if (lockedAt !== null) {
      const remainingMs = lockedAt.getTime() + this.lockMs - now;
      throw appErrors.tooManyRequests('login_locked', `로그인 실패가 많아 잠겼습니다. ${Math.ceil(remainingMs / MS_PER_MINUTE)}분 뒤 다시 시도하십시오`);
    }
  }

  async recordFailure(accountKey: string): Promise<void> {
    const now = this.clock.now();
    const failures = await this.accountLog.recordAndCount(failureBucket(accountKey), now, new Date(now.getTime() - this.lockMs));
    if (failures >= this.settings.maxFailures) {
      await this.accountLog.record(lockBucket(accountKey), now);
      // 잠긴 뒤에는 실패 기록을 새로 센다. 잠금이 풀리자마자 한 번 틀려서 다시 잠기지 않게 한다
      await this.accountLog.clear(failureBucket(accountKey));
    }
  }

  async reset(accountKey: string): Promise<void> {
    await this.accountLog.clear(failureBucket(accountKey));
  }

  private get lockMs(): number {
    return this.settings.lockMinutes * MS_PER_MINUTE;
  }
}

function failureBucket(accountKey: string): string {
  return `login-fail:${accountKey}`;
}

function lockBucket(accountKey: string): string {
  return `login-lock:${accountKey}`;
}
