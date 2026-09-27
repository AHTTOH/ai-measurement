import { tables, type Database } from '@ai-measurement/infra';
import {
  answerContentsEqual,
  answerFormatMismatch,
  isSubquestionVisible,
  type AnswerContent,
  type CandidateAnswerView,
  type SaveAnswerResponse,
} from '@ai-measurement/shared';
import { and, desc, eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import type { Clock } from '../../lib/clock';
import type { CandidatePrincipal } from '../auth/candidate-auth-service';
import type { ExamCatalog } from '../exams/exam-catalog';
import type { NoticeService } from '../notices/notice-service';
import type { ExamSessionService } from '../sessions/exam-session-service';

type AnswerRecord = typeof tables.answers.$inferSelect;

export function toAnswerView(latest: AnswerRecord, lastSubmittedAt: Date | null): CandidateAnswerView {
  return {
    subquestionKey: latest.subquestionKey,
    version: latest.version,
    content: latest.content,
    savedAt: latest.savedAt.toISOString(),
    lastSubmittedAt: lastSubmittedAt?.toISOString() ?? null,
    latestIsFinal: latest.isFinal,
  };
}

/**
 * 답안 자동저장·최종 제출(PRD 11장 "중간 답안, 최종 답안, 답안 수정 이력").
 * 저장할 때마다 새 버전을 추가하고, 내용이 같으면 버전을 늘리지 않는다.
 */
export class AnswerService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ExamCatalog,
    private readonly sessions: ExamSessionService,
    private readonly notices: NoticeService,
    private readonly clock: Clock,
  ) {}

  async save(principal: CandidatePrincipal, subquestionKey: string, content: AnswerContent, submit: boolean): Promise<SaveAnswerResponse> {
    const session = await this.sessions.requireWritable(principal.candidateId);
    const exam = await this.catalog.get(session.examId);
    const { caseDef, subquestion } = this.catalog.findSubquestion(exam, subquestionKey);
    const revealedBefore = await this.notices.revealed(exam, session);
    if (!isSubquestionVisible(subquestion, revealedBefore.get(caseDef.key) ?? new Map())) {
      throw appErrors.forbidden('subquestion_locked', '아직 열리지 않은 하위문항입니다');
    }
    const mismatch = answerFormatMismatch(subquestion.answer, content);
    if (mismatch !== null) throw appErrors.badRequest('invalid_answer', mismatch);

    const latest = await this.db.transaction(async (tx) => {
      await this.sessions.lockActive(tx, session.id);
      const [current] = await tx
        .select()
        .from(tables.answers)
        .where(and(eq(tables.answers.examSessionId, session.id), eq(tables.answers.subquestionKey, subquestionKey)))
        .orderBy(desc(tables.answers.version))
        .limit(1);
      const unchanged = current !== undefined && answerContentsEqual(current.content, content) && (current.isFinal || !submit);
      if (unchanged) return current;
      const [inserted] = await tx
        .insert(tables.answers)
        .values({
          examSessionId: session.id,
          subquestionKey,
          version: (current?.version ?? 0) + 1,
          content,
          isFinal: submit,
          source: submit ? 'candidate_submit' : 'candidate_save',
          savedAt: this.clock.now(),
        })
        .returning();
      if (inserted === undefined) throw new Error('답안을 저장하지 못했습니다');
      return inserted;
    });

    const revealedAfter = submit ? await this.notices.revealed(exam, session) : revealedBefore;
    const newlyRevealedNotices = submit ? await this.notices.recordNewReveals(exam, session, revealedAfter) : [];
    const lastSubmittedAt = await this.lastSubmittedAt(session.id, subquestionKey);
    return { answer: toAnswerView(latest, lastSubmittedAt), newlyRevealedNotices };
  }

  /** 하위문항별 최신 답안 */
  async latestAnswers(examSessionId: string): Promise<CandidateAnswerView[]> {
    const rows = await this.db
      .select()
      .from(tables.answers)
      .where(eq(tables.answers.examSessionId, examSessionId))
      .orderBy(tables.answers.subquestionKey, desc(tables.answers.version));
    const views: CandidateAnswerView[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.subquestionKey)) continue;
      seen.add(row.subquestionKey);
      const lastFinal = rows.find((r) => r.subquestionKey === row.subquestionKey && r.isFinal);
      views.push(toAnswerView(row, lastFinal?.savedAt ?? null));
    }
    return views;
  }

  private async lastSubmittedAt(examSessionId: string, subquestionKey: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ savedAt: tables.answers.savedAt })
      .from(tables.answers)
      .where(and(eq(tables.answers.examSessionId, examSessionId), eq(tables.answers.subquestionKey, subquestionKey), eq(tables.answers.isFinal, true)))
      .orderBy(desc(tables.answers.version))
      .limit(1);
    return row?.savedAt ?? null;
  }
}
