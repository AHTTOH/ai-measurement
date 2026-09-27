import { tables, type Database } from '@ai-measurement/infra';
import type {
  AdminConversationView,
  AnswerVersionView,
  GradeItemView,
  SessionDetailResponse,
  TimelineEventView,
  ViolationView,
} from '@ai-measurement/shared';
import { and, asc, eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { conversationSummary } from '../ai/chat-service';
import { materialTitleMap } from '../ai/material-titles';
import { messageView, selectionView } from '../ai/message-views';
import type { ExamCatalog } from '../exams/exam-catalog';
import type { TokenLedgerService } from '../ledger/token-ledger-service';
import { latestDoneJobId, scoresForJob } from './score-views';

/** 응시자 한 명의 도달 과정 전체(PRD 11장 "어떻게 결과에 도달했는지") */
export class SessionDetailService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ExamCatalog,
    private readonly ledger: TokenLedgerService,
  ) {}

  async detail(examSessionId: string): Promise<SessionDetailResponse> {
    const [row] = await this.db
      .select({ session: tables.examSessions, candidate: { candidateNo: tables.candidates.candidateNo } })
      .from(tables.examSessions)
      .innerJoin(tables.candidates, eq(tables.candidates.id, tables.examSessions.candidateId))
      .where(eq(tables.examSessions.id, examSessionId))
      .limit(1);
    if (row === undefined) throw appErrors.notFound('session_not_found', '응시 세션을 찾을 수 없습니다');
    const { session, candidate } = row;
    const exam = await this.catalog.get(session.examId);
    const jobId = await latestDoneJobId(this.db, exam.id);

    return {
      examId: exam.id,
      examTitle: exam.title,
      cases: exam.definition.cases.map((c) => ({ key: c.key, title: c.title })),
      candidateNo: candidate.candidateNo,
      session: {
        id: session.id,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        tokenBudget: session.tokenBudget,
        tokenBalance: await this.ledger.balance(this.db, session.id),
      },
      ...(await this.conversationsAndAttachments(examSessionId, materialTitleMap(exam.definition))),
      ledger: await this.ledger.entries(examSessionId),
      answers: await this.answerVersions(examSessionId),
      timeline: await this.timeline(examSessionId),
      latestScore: jobId !== null ? ((await scoresForJob(this.db, jobId, [examSessionId])).get(examSessionId) ?? null) : null,
      gradeItems: jobId !== null ? await this.gradeItems(jobId, examSessionId) : [],
      violations: jobId !== null ? await this.violations(jobId, examSessionId) : [],
    };
  }

  private async conversationsAndAttachments(examSessionId: string, titles: Map<string, string>): Promise<Pick<SessionDetailResponse, 'conversations' | 'attachments'>> {
    const conversations = await this.db
      .select()
      .from(tables.conversations)
      .where(eq(tables.conversations.examSessionId, examSessionId))
      .orderBy(asc(tables.conversations.caseKey), asc(tables.conversations.seq));
    const messages = await this.db.select().from(tables.messages).where(eq(tables.messages.examSessionId, examSessionId)).orderBy(asc(tables.messages.seq));
    const attachments = await this.db.select().from(tables.attachments).where(eq(tables.attachments.examSessionId, examSessionId));
    const views: AdminConversationView[] = conversations.map((c) => ({
      ...conversationSummary(c),
      messages: messages
        .filter((m) => m.conversationId === c.id)
        .map((m) => ({
          ...messageView(m, attachments, titles),
          contextTokens: m.contextTokens,
          patternHits: m.patternHits ?? [],
          usage: m.usage,
          latencyMs: m.latencyMs,
          model: m.model,
        })),
    }));
    return {
      conversations: views,
      attachments: attachments.map((a) => ({ id: a.id, messageId: a.messageId, materialKey: a.materialKey, selection: selectionView(a.selection) })),
    };
  }

  private async answerVersions(examSessionId: string): Promise<AnswerVersionView[]> {
    const rows = await this.db
      .select()
      .from(tables.answers)
      .where(eq(tables.answers.examSessionId, examSessionId))
      .orderBy(asc(tables.answers.subquestionKey), asc(tables.answers.version));
    return rows.map((a) => ({
      subquestionKey: a.subquestionKey,
      version: a.version,
      content: a.content,
      isFinal: a.isFinal,
      source: a.source,
      savedAt: a.savedAt.toISOString(),
    }));
  }

  private async timeline(examSessionId: string): Promise<TimelineEventView[]> {
    const clientEvents = await this.db.select().from(tables.clientEvents).where(eq(tables.clientEvents.examSessionId, examSessionId));
    const auditEvents = await this.db.select().from(tables.auditEvents).where(eq(tables.auditEvents.examSessionId, examSessionId));
    const events: TimelineEventView[] = [
      ...clientEvents.map((e) => ({ at: e.at.toISOString(), kind: e.kind, subquestionKey: e.subquestionKey, payload: {} })),
      ...auditEvents.map((e) => ({ at: e.createdAt.toISOString(), kind: e.kind, subquestionKey: null, payload: { ...e.payload, actor: e.actor } })),
    ];
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }

  private async gradeItems(jobId: string, examSessionId: string): Promise<GradeItemView[]> {
    const rows = await this.db
      .select()
      .from(tables.gradeItems)
      .where(and(eq(tables.gradeItems.gradingJobId, jobId), eq(tables.gradeItems.examSessionId, examSessionId)))
      .orderBy(asc(tables.gradeItems.caseKey), asc(tables.gradeItems.axis), asc(tables.gradeItems.itemId));
    return rows.map((g) => ({
      caseKey: g.caseKey,
      axis: g.axis,
      itemId: g.itemId,
      itemKind: g.itemKind,
      description: g.description,
      points: g.points,
      earned: g.earned,
      status: g.status,
      grader: g.grader,
      detail: g.detail,
    }));
  }

  private async violations(jobId: string, examSessionId: string): Promise<ViolationView[]> {
    const rows = await this.db
      .select()
      .from(tables.violations)
      .where(and(eq(tables.violations.gradingJobId, jobId), eq(tables.violations.examSessionId, examSessionId)));
    return rows.map((v) => ({ id: v.id, messageId: v.messageId, source: v.source, tag: v.tag, label: v.label, count: v.count }));
  }
}
