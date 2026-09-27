import { tables, type Database, type DbExecutor } from '@ai-measurement/infra';
import { computeNoticeRevealTimes, type CandidateNoticeView, type CaseDefinition } from '@ai-measurement/shared';
import { and, eq, min } from 'drizzle-orm';
import type { Clock } from '../../lib/clock';
import { actorOf, writeAudit } from '../audit/audit-log';
import type { ExamRecord } from '../exams/exam-catalog';
import type { ExamSessionRecord } from '../sessions/exam-session-service';

export type RevealedNotices = Map<string, Map<string, Date>>;

/**
 * PRD 7장 진행 중 조건 변경. 공지 노출은 공통 계산(shared)으로 구하고,
 * 처음 노출된 시점을 감사 로그(notice_revealed)에 한 번씩 남긴다.
 */
export class NoticeService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** 응시자가 직접 최종 제출한 최초 시각(하위문항별). 시험 종료 시 자동 최종 처리는 제외한다 */
  async firstSubmissionTimes(executor: DbExecutor, examSessionId: string): Promise<Map<string, Date>> {
    const rows = await executor
      .select({ key: tables.answers.subquestionKey, at: min(tables.answers.savedAt) })
      .from(tables.answers)
      .where(and(eq(tables.answers.examSessionId, examSessionId), eq(tables.answers.source, 'candidate_submit')))
      .groupBy(tables.answers.subquestionKey);
    return new Map(rows.filter((r): r is { key: string; at: Date } => r.at !== null).map((r) => [r.key, r.at]));
  }

  async revealed(exam: ExamRecord, session: ExamSessionRecord): Promise<RevealedNotices> {
    const firstFinalSubmissionAt = await this.firstSubmissionTimes(this.db, session.id);
    const now = session.endedAt ?? this.clock.now();
    return new Map(
      exam.definition.cases.map((caseDef) => [
        caseDef.key,
        computeNoticeRevealTimes(caseDef, { sessionStartedAt: session.startedAt, firstFinalSubmissionAt, now }),
      ]),
    );
  }

  /** 새로 열린 공지를 감사 로그에 남기고 그 목록을 돌려준다 */
  async recordNewReveals(exam: ExamRecord, session: ExamSessionRecord, revealed: RevealedNotices): Promise<CandidateNoticeView[]> {
    const logged = await this.db
      .select({ payload: tables.auditEvents.payload })
      .from(tables.auditEvents)
      .where(and(eq(tables.auditEvents.examSessionId, session.id), eq(tables.auditEvents.kind, 'notice_revealed')));
    const loggedKeys = new Set(logged.map((l) => String(l.payload['noticeKey'])));
    const fresh: CandidateNoticeView[] = [];
    for (const caseDef of exam.definition.cases) {
      for (const [noticeKey, revealedAt] of revealed.get(caseDef.key) ?? new Map<string, Date>()) {
        if (loggedKeys.has(noticeKey)) continue;
        await writeAudit(this.db, {
          examId: exam.id,
          examSessionId: session.id,
          actor: actorOf.system,
          kind: 'notice_revealed',
          payload: { noticeKey, caseKey: caseDef.key, effectiveAt: revealedAt.toISOString() },
        });
        const view = noticeView(caseDef, noticeKey, revealedAt);
        if (view !== null) fresh.push(view);
      }
    }
    return fresh;
  }
}

export function noticeView(caseDef: CaseDefinition, noticeKey: string, revealedAt: Date): CandidateNoticeView | null {
  const notice = caseDef.notices.find((n) => n.key === noticeKey);
  if (notice === undefined) return null;
  return { key: notice.key, from: notice.from, title: notice.title, body: notice.body, revealedAt: revealedAt.toISOString() };
}
