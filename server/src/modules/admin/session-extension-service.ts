import { tables, type Database } from '@ai-measurement/infra';
import { eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { MS_PER_MINUTE } from '../../lib/clock';
import { actorOf, writeAudit } from '../audit/audit-log';

/**
 * 운영자 시간 연장(결정 D11). 관리자 서버에만 있다.
 * 수험생 서버 DB 역할은 expires_at을 바꿀 권한이 없다(0001_access-roles.sql).
 */
export class SessionExtensionService {
  constructor(private readonly db: Database) {}

  async extend(examSessionId: string, minutes: number, reason: string, adminId: string): Promise<Date> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select({ examId: tables.examSessions.examId, status: tables.examSessions.status, expiresAt: tables.examSessions.expiresAt })
        .from(tables.examSessions)
        .where(eq(tables.examSessions.id, examSessionId))
        .for('update');
      if (session === undefined) throw appErrors.notFound('session_not_found', '응시 세션을 찾을 수 없습니다');
      if (session.status !== 'active') throw appErrors.conflict('session_not_active', '진행 중인 세션만 연장할 수 있습니다');
      const expiresAt = new Date(session.expiresAt.getTime() + minutes * MS_PER_MINUTE);
      await tx.update(tables.examSessions).set({ expiresAt }).where(eq(tables.examSessions.id, examSessionId));
      await writeAudit(tx, {
        examId: session.examId,
        examSessionId,
        actor: actorOf.admin(adminId),
        kind: 'session_extended',
        payload: { minutes, reason, previousExpiresAt: session.expiresAt.toISOString(), expiresAt: expiresAt.toISOString() },
      });
      return expiresAt;
    });
  }
}
