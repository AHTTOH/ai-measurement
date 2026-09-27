import { tables, type Database } from '@ai-measurement/infra';
import { eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { dummySecretHash, verifySecret } from '../../lib/secrets';
import { actorOf, writeAudit } from '../audit/audit-log';
import type { AuthSessionStore, LoginResult } from './auth-session-store';
import type { LoginThrottle } from './login-throttle';

export interface AdminPrincipal {
  authSessionId: string;
  adminId: string;
  username: string;
}

const INVALID_ADMIN_LOGIN = '아이디 또는 비밀번호가 올바르지 않습니다';

/** 운영자 로그인. 관리자 서버에만 있다 */
export class AdminAuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: AuthSessionStore,
    private readonly throttle: LoginThrottle,
  ) {}

  async login(username: string, password: string, clientAddress: string): Promise<LoginResult<AdminPrincipal>> {
    const accountKey = `admin:${username}`;
    await this.throttle.assertAllowed(accountKey, clientAddress);
    const [admin] = await this.db.select().from(tables.admins).where(eq(tables.admins.username, username)).limit(1);
    const valid = await verifySecret(password, admin?.passwordHash ?? (await dummySecretHash()));
    if (admin === undefined || !valid) {
      await this.throttle.recordFailure(accountKey);
      throw appErrors.unauthorized(INVALID_ADMIN_LOGIN);
    }
    await this.throttle.reset(accountKey);

    const issued = await this.sessions.issue(this.db, 'admin', admin.id);
    await writeAudit(this.db, { examId: null, examSessionId: null, actor: actorOf.admin(admin.id), kind: 'admin_login', payload: {} });
    return { token: issued.token, expiresAt: issued.expiresAt, principal: { authSessionId: issued.authSessionId, adminId: admin.id, username: admin.username } };
  }

  async resolve(token: string): Promise<AdminPrincipal | null> {
    const [row] = await this.db
      .select({ authSessionId: tables.authSessions.id, adminId: tables.admins.id, username: tables.admins.username })
      .from(tables.authSessions)
      .innerJoin(tables.admins, eq(tables.admins.id, tables.authSessions.principalId))
      .where(this.sessions.activeTokenCondition(token, 'admin'))
      .limit(1);
    return row ?? null;
  }

  logout(authSessionId: string): Promise<void> {
    return this.sessions.logout(authSessionId);
  }
}
