import { tables, type Database } from '@ai-measurement/infra';
import { eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { dummySecretHash, verifySecret } from '../../lib/secrets';
import { actorOf, writeAudit } from '../audit/audit-log';
import type { AuthSessionStore, LoginResult } from './auth-session-store';
import type { LoginThrottle } from './login-throttle';

export interface CandidatePrincipal {
  authSessionId: string;
  candidateId: string;
  candidateNo: string;
  examId: string;
}

const INVALID_CANDIDATE_LOGIN = '응시번호 또는 PIN이 올바르지 않습니다';

/** 수험생 로그인(결정 D8). 수험생 서버에만 있다 */
export class CandidateAuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: AuthSessionStore,
    private readonly throttle: LoginThrottle,
  ) {}

  async login(candidateNo: string, pin: string, clientAddress: string): Promise<LoginResult<CandidatePrincipal>> {
    const accountKey = `candidate:${candidateNo}`;
    await this.throttle.assertAllowed(accountKey, clientAddress);
    const [candidate] = await this.db.select().from(tables.candidates).where(eq(tables.candidates.candidateNo, candidateNo)).limit(1);
    const valid = await verifySecret(pin, candidate?.pinHash ?? (await dummySecretHash()));
    if (candidate === undefined || !valid) {
      await this.throttle.recordFailure(accountKey);
      throw appErrors.unauthorized(INVALID_CANDIDATE_LOGIN);
    }
    await this.throttle.reset(accountKey);

    // 같은 응시번호의 이전 로그인은 끊는다(대리 응시·중복 접속 방지)
    const issued = await this.db.transaction(async (tx) => {
      const replaced = await this.sessions.revokeAll(tx, 'candidate', candidate.id, 'replaced_by_new_login');
      const session = await this.sessions.issue(tx, 'candidate', candidate.id);
      await writeAudit(tx, {
        examId: candidate.examId,
        examSessionId: null,
        actor: actorOf.candidate(candidate.id),
        kind: 'candidate_login',
        payload: { replacedLoginSessions: replaced },
      });
      return session;
    });
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      principal: { authSessionId: issued.authSessionId, candidateId: candidate.id, candidateNo: candidate.candidateNo, examId: candidate.examId },
    };
  }

  async resolve(token: string): Promise<CandidatePrincipal | null> {
    const [row] = await this.db
      .select({
        authSessionId: tables.authSessions.id,
        candidateId: tables.candidates.id,
        candidateNo: tables.candidates.candidateNo,
        examId: tables.candidates.examId,
      })
      .from(tables.authSessions)
      .innerJoin(tables.candidates, eq(tables.candidates.id, tables.authSessions.principalId))
      .where(this.sessions.activeTokenCondition(token, 'candidate'))
      .limit(1);
    return row ?? null;
  }

  logout(authSessionId: string): Promise<void> {
    return this.sessions.logout(authSessionId);
  }
}
