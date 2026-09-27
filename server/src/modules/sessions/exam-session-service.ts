import { tables, type Database, type Transaction } from '@ai-measurement/infra';
import { and, desc, eq, lte } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { MS_PER_MINUTE, type Clock } from '../../lib/clock';
import { isUniqueViolation } from '../../lib/db-errors';
import { actorOf, writeAudit } from '../audit/audit-log';
import type { CandidatePrincipal } from '../auth/candidate-auth-service';
import type { ExamCatalog } from '../exams/exam-catalog';
import type { TokenLedgerService } from '../ledger/token-ledger-service';

export type ExamSessionRecord = typeof tables.examSessions.$inferSelect;
export type SessionEndReason = 'submitted' | 'expired';

/** 응시 세션: 시작, 쓰기 가능 여부 확인, 종료(제출·만료). 시간 연장은 관리자 서버의 SessionExtensionService */
export class ExamSessionService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ExamCatalog,
    private readonly ledger: TokenLedgerService,
    private readonly clock: Clock,
  ) {}

  async findByCandidate(candidateId: string): Promise<ExamSessionRecord | null> {
    const [session] = await this.db.select().from(tables.examSessions).where(eq(tables.examSessions.candidateId, candidateId)).limit(1);
    return session ?? null;
  }

  async findById(examSessionId: string): Promise<ExamSessionRecord> {
    const [session] = await this.db.select().from(tables.examSessions).where(eq(tables.examSessions.id, examSessionId)).limit(1);
    if (session === undefined) throw appErrors.notFound('session_not_found', '응시 세션을 찾을 수 없습니다');
    return session;
  }

  async start(principal: CandidatePrincipal): Promise<ExamSessionRecord> {
    const exam = await this.catalog.get(principal.examId);
    if (exam.status !== 'open') throw appErrors.conflict('exam_not_open', '시험이 아직 열리지 않았거나 이미 종료되었습니다');
    const now = this.clock.now();
    const actor = actorOf.candidate(principal.candidateId);
    try {
      return await this.db.transaction(async (tx) => {
        const [session] = await tx
          .insert(tables.examSessions)
          .values({
            examId: exam.id,
            candidateId: principal.candidateId,
            status: 'active',
            startedAt: now,
            expiresAt: new Date(now.getTime() + exam.definition.durationMinutes * MS_PER_MINUTE),
            tokenBudget: exam.definition.tokenBudget,
          })
          .returning();
        if (session === undefined) throw new Error('응시 세션을 만들지 못했습니다');
        await this.ledger.initialize(tx, session.id, exam.definition.tokenBudget, actor);
        await tx.insert(tables.conversations).values(
          exam.definition.cases.map((c) => ({ examSessionId: session.id, caseKey: c.key, seq: 1, status: 'active' as const })),
        );
        await writeAudit(tx, { examId: exam.id, examSessionId: session.id, actor, kind: 'session_started', payload: { expiresAt: session.expiresAt.toISOString() } });
        return session;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw appErrors.conflict('session_exists', '이미 시험을 시작했습니다');
      throw error;
    }
  }

  /** 응시자 쓰기 요청 앞에서 호출한다. 시간이 지났으면 종료 처리하고 410을 던진다 */
  async requireWritable(candidateId: string): Promise<ExamSessionRecord> {
    const session = await this.findByCandidate(candidateId);
    if (session === null) throw appErrors.conflict('session_not_started', '아직 시험을 시작하지 않았습니다');
    if (session.status !== 'active') throw appErrors.gone('session_ended', '시험이 끝났습니다. 더 이상 제출하거나 AI를 사용할 수 없습니다');
    if (this.clock.now().getTime() >= session.expiresAt.getTime()) {
      await this.end(session.id, 'expired', actorOf.system);
      throw appErrors.gone('session_ended', '시험 시간이 끝났습니다. 마지막으로 저장한 답안이 최종 제출되었습니다');
    }
    return session;
  }

  /** 트랜잭션 안에서 세션 행을 잠그고 아직 진행 중인지 다시 확인한다 */
  async lockActive(tx: Transaction, examSessionId: string): Promise<ExamSessionRecord> {
    const [session] = await tx.select().from(tables.examSessions).where(eq(tables.examSessions.id, examSessionId)).for('update');
    if (session === undefined) throw appErrors.notFound('session_not_found', '응시 세션을 찾을 수 없습니다');
    if (session.status !== 'active' || this.clock.now().getTime() >= session.expiresAt.getTime()) {
      throw appErrors.gone('session_ended', '시험이 끝났습니다');
    }
    return session;
  }

  /** 종료 처리. 이미 끝난 세션이면 아무것도 하지 않는다 */
  async end(examSessionId: string, reason: SessionEndReason, actor: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(tables.examSessions).where(eq(tables.examSessions.id, examSessionId)).for('update');
      if (session === undefined || session.status !== 'active') return;
      const now = this.clock.now();
      const finalized = await this.finalizeLatestAnswers(tx, examSessionId, now);
      await tx.update(tables.examSessions).set({ status: reason, endedAt: now }).where(eq(tables.examSessions.id, examSessionId));
      await tx.update(tables.conversations).set({ status: 'closed', closedAt: now }).where(and(eq(tables.conversations.examSessionId, examSessionId), eq(tables.conversations.status, 'active')));
      await writeAudit(tx, { examId: session.examId, examSessionId, actor, kind: 'session_ended', payload: { reason, autoFinalizedAnswers: finalized } });
    });
  }

  /** 하위문항마다 최신 버전이 최종 제출본이 아니면 같은 내용으로 최종 버전을 추가한다(구현계획 4.4) */
  private async finalizeLatestAnswers(tx: Transaction, examSessionId: string, now: Date): Promise<number> {
    const latest = await tx
      .selectDistinctOn([tables.answers.subquestionKey])
      .from(tables.answers)
      .where(eq(tables.answers.examSessionId, examSessionId))
      .orderBy(tables.answers.subquestionKey, desc(tables.answers.version));
    const pending = latest.filter((a) => !a.isFinal);
    if (pending.length > 0) {
      await tx.insert(tables.answers).values(
        pending.map((a) => ({
          examSessionId,
          subquestionKey: a.subquestionKey,
          version: a.version + 1,
          content: a.content,
          isFinal: true,
          source: 'auto_final_on_end' as const,
          savedAt: now,
        })),
      );
    }
    return pending.length;
  }

  /** 시간이 지난 진행 중 세션을 모두 종료한다. 종료한 개수를 돌려준다 */
  async sweepExpired(): Promise<number> {
    const expired = await this.db
      .select({ id: tables.examSessions.id })
      .from(tables.examSessions)
      .where(and(eq(tables.examSessions.status, 'active'), lte(tables.examSessions.expiresAt, this.clock.now())));
    for (const session of expired) {
      await this.end(session.id, 'expired', actorOf.system);
    }
    return expired.length;
  }
}
