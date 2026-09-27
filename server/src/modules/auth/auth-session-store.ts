import { tables, type Database, type DbExecutor, type PrincipalType } from '@ai-measurement/infra';
import { and, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { MS_PER_HOUR, type Clock } from '../../lib/clock';
import { newSessionToken, sha256Hex } from '../../lib/secrets';

export interface LoginResult<P> {
  token: string;
  principal: P;
  expiresAt: Date;
}

export interface IssuedSession {
  token: string;
  authSessionId: string;
  expiresAt: Date;
}

/**
 * 로그인 세션(쿠키 토큰) 발급·확인·폐기. 응시자 서버와 관리자 서버가 같은 방식으로 쓴다.
 * 토큰 원문은 저장하지 않고 SHA-256 해시만 저장한다.
 */
export class AuthSessionStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly sessionHours: number,
  ) {}

  async issue(executor: DbExecutor, principalType: PrincipalType, principalId: string): Promise<IssuedSession> {
    const token = newSessionToken();
    const expiresAt = new Date(this.clock.now().getTime() + this.sessionHours * MS_PER_HOUR);
    const [created] = await executor
      .insert(tables.authSessions)
      .values({ tokenHash: sha256Hex(token), principalType, principalId, expiresAt })
      .returning({ id: tables.authSessions.id });
    if (created === undefined) throw new Error('로그인 세션을 만들지 못했습니다');
    return { token, authSessionId: created.id, expiresAt };
  }

  /** 한 주체의 살아 있는 로그인 세션을 모두 끊고 끊은 수를 돌려준다 */
  async revokeAll(executor: DbExecutor, principalType: PrincipalType, principalId: string, reason: string): Promise<number> {
    const revoked = await executor
      .update(tables.authSessions)
      .set({ revokedAt: this.clock.now(), revokedReason: reason })
      .where(and(eq(tables.authSessions.principalType, principalType), eq(tables.authSessions.principalId, principalId), isNull(tables.authSessions.revokedAt)))
      .returning({ id: tables.authSessions.id });
    return revoked.length;
  }

  async logout(authSessionId: string): Promise<void> {
    await this.db
      .update(tables.authSessions)
      .set({ revokedAt: this.clock.now(), revokedReason: 'logout' })
      .where(and(eq(tables.authSessions.id, authSessionId), isNull(tables.authSessions.revokedAt)));
  }

  /** 토큰이 가리키는 살아 있는 세션 조건(폐기되지 않고 만료 전) */
  activeTokenCondition(token: string, principalType: PrincipalType): SQL | undefined {
    return and(
      eq(tables.authSessions.tokenHash, sha256Hex(token)),
      eq(tables.authSessions.principalType, principalType),
      isNull(tables.authSessions.revokedAt),
      gt(tables.authSessions.expiresAt, this.clock.now()),
    );
  }
}
