import { tables, type Database } from '@ai-measurement/infra';
import {
  isSubquestionVisible,
  type CandidateCaseView,
  type CandidateStateResponse,
  type ClientEventRequest,
} from '@ai-measurement/shared';
import type { Clock } from '../../lib/clock';
import type { AiGateway } from '../ai/ai-gateway';
import type { ChatService } from '../ai/chat-service';
import type { AnswerService } from '../answers/answer-service';
import { actorOf } from '../audit/audit-log';
import type { CandidatePrincipal } from '../auth/candidate-auth-service';
import type { ExamCatalog, ExamRecord } from '../exams/exam-catalog';
import type { TokenLedgerService } from '../ledger/token-ledger-service';
import { noticeView, type NoticeService, type RevealedNotices } from '../notices/notice-service';
import type { ExamSessionService } from '../sessions/exam-session-service';

function caseViews(exam: ExamRecord, revealed: RevealedNotices): CandidateCaseView[] {
  return exam.definition.cases.map((caseDef) => {
    const caseRevealed = revealed.get(caseDef.key) ?? new Map<string, Date>();
    return {
      key: caseDef.key,
      title: caseDef.title,
      brief: caseDef.brief,
      materials: caseDef.materials.map((m) => ({ key: m.key, title: m.title, kind: m.kind })),
      subquestions: caseDef.subquestions
        .filter((s) => isSubquestionVisible(s, caseRevealed))
        .map((s) => ({ key: s.key, title: s.title, type: s.type, prompt: s.prompt, answer: s.answer, guidance: s.guidance ?? [] })),
      notices: [...caseRevealed.entries()]
        .map(([key, at]) => noticeView(caseDef, key, at))
        .filter((n): n is NonNullable<typeof n> => n !== null),
    };
  });
}

/**
 * 응시자 화면에 필요한 전체 상태. 화면은 이 응답과 서버 시각(serverNow)으로 타이머를 맞춘다.
 * Case 내용은 시험을 시작한 뒤에만 준다.
 */
export class CandidateStateService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ExamCatalog,
    private readonly sessions: ExamSessionService,
    private readonly ledger: TokenLedgerService,
    private readonly answers: AnswerService,
    private readonly notices: NoticeService,
    private readonly chat: ChatService,
    private readonly ai: AiGateway,
    private readonly clock: Clock,
  ) {}

  async getState(principal: CandidatePrincipal): Promise<CandidateStateResponse> {
    const exam = await this.catalog.get(principal.examId);
    let session = await this.sessions.findByCandidate(principal.candidateId);
    if (session !== null && session.status === 'active' && this.clock.now().getTime() >= session.expiresAt.getTime()) {
      await this.sessions.end(session.id, 'expired', actorOf.system);
      session = await this.sessions.findById(session.id);
    }
    const base: CandidateStateResponse = {
      serverNow: this.clock.now().toISOString(),
      aiProvider: this.ai.provider,
      candidateNo: principal.candidateNo,
      exam: {
        title: exam.definition.title,
        status: exam.status,
        candidateNotice: exam.definition.candidateNotice,
        durationMinutes: exam.definition.durationMinutes,
        tokenBudget: exam.definition.tokenBudget,
        contextTokenLimit: exam.definition.contextTokenLimit,
        caseCount: exam.definition.cases.length,
      },
      session: null,
      cases: [],
      answers: [],
      conversations: [],
    };
    if (session === null) return base;

    const revealed = await this.notices.revealed(exam, session);
    await this.notices.recordNewReveals(exam, session, revealed);
    return {
      ...base,
      session: {
        id: session.id,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        tokenBudget: session.tokenBudget,
        tokenBalance: await this.ledger.balance(this.db, session.id),
      },
      cases: caseViews(exam, revealed),
      answers: await this.answers.latestAnswers(session.id),
      conversations: await this.chat.listConversations(session.id),
    };
  }

  /** 하위문항 진입·이탈, 탭 전환 기록(PRD 11장 "문항별 시간", 구현계획 1장 탭 이탈 로그) */
  async recordClientEvent(principal: CandidatePrincipal, event: ClientEventRequest): Promise<void> {
    const session = await this.sessions.requireWritable(principal.candidateId);
    if (event.subquestionKey !== null) this.catalog.findSubquestion(await this.catalog.get(session.examId), event.subquestionKey);
    await this.db.insert(tables.clientEvents).values({
      examSessionId: session.id,
      kind: event.kind,
      subquestionKey: event.subquestionKey,
      at: this.clock.now(),
    });
  }
}
