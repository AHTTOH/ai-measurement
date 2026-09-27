import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { tables, type Database, type DbExecutor, type StoredUserBlock } from '@ai-measurement/infra';
import {
  findPatternHits,
  type AiSettings,
  type ConversationDetailResponse,
  type ConversationSummary,
  type SendMessageRequest,
  type SendMessageResponse,
} from '@ai-measurement/shared';
import { and, asc, eq, inArray, max } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import type { Clock } from '../../lib/clock';
import { isUniqueViolation } from '../../lib/db-errors';
import type { Logger } from '../../lib/logger';
import type { SlidingWindowLimiter } from '../../lib/sliding-window-limiter';
import { actorOf } from '../audit/audit-log';
import type { CandidatePrincipal } from '../auth/candidate-auth-service';
import type { ExamCatalog, ExamRecord } from '../exams/exam-catalog';
import { insufficientTokens, type TokenLedgerService } from '../ledger/token-ledger-service';
import type { MaterialService, RenderedAttachment } from '../materials/material-service';
import type { ExamSessionService } from '../sessions/exam-session-service';
import { AI_FAILURE_MESSAGES, AiGatewayError, type AiGateway } from './ai-gateway';
import { buildConversationHistory, userBlocksToApi, type AttachmentPayload } from './conversation-history';
import { materialTitleMap } from './material-titles';
import { assistantPlainText, messageView, type AttachmentRecord, type MessageRecord } from './message-views';
import type { StreamHub } from './stream-hub';

type ConversationRecord = typeof tables.conversations.$inferSelect;

interface CompletionContext {
  conversationId: string;
  examSessionId: string;
  subquestionKey: string | null;
  settings: AiSettings;
  messages: Anthropic.MessageParam[];
  materialTitles: Map<string, string>;
}

export function conversationSummary(c: ConversationRecord): ConversationSummary {
  return { id: c.id, caseKey: c.caseKey, seq: c.seq, status: c.status, createdAt: c.createdAt.toISOString() };
}

async function nextMessageSeq(executor: DbExecutor, conversationId: string): Promise<number> {
  const [row] = await executor.select({ value: max(tables.messages.seq) }).from(tables.messages).where(eq(tables.messages.conversationId, conversationId));
  return (row?.value ?? 0) + 1;
}

/**
 * 응시용 AI 채팅(PRD 2·6·11장).
 * 전송 흐름: 첨부 렌더링 → 신규 전송분 토큰 계산(차감 기준, 결정 D2) → 전체 컨텍스트 계산(상한, 결정 D4)
 * → 세션 행 잠금 트랜잭션에서 잔액 확인·메시지 저장·원장 차감 → 백그라운드로 AI 응답 스트리밍·저장.
 */
export class ChatService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ExamCatalog,
    private readonly sessions: ExamSessionService,
    private readonly ledger: TokenLedgerService,
    private readonly materials: MaterialService,
    private readonly ai: AiGateway,
    private readonly hub: StreamHub,
    private readonly clock: Clock,
    /** 응시 세션별 AI 요청 한도(분당). 여러 서버가 나눠 쓰는 기록 위에서 돈다 */
    private readonly limiter: SlidingWindowLimiter,
    private readonly logger: Logger,
  ) {}

  async ownedConversation(principal: CandidatePrincipal, conversationId: string): Promise<ConversationRecord> {
    const [row] = await this.db
      .select({ conversation: tables.conversations })
      .from(tables.conversations)
      .innerJoin(tables.examSessions, eq(tables.examSessions.id, tables.conversations.examSessionId))
      .where(and(eq(tables.conversations.id, conversationId), eq(tables.examSessions.candidateId, principal.candidateId)))
      .limit(1);
    if (row === undefined) throw appErrors.notFound('conversation_not_found', '대화를 찾을 수 없습니다');
    return row.conversation;
  }

  async listConversations(examSessionId: string): Promise<ConversationSummary[]> {
    const rows = await this.db
      .select()
      .from(tables.conversations)
      .where(eq(tables.conversations.examSessionId, examSessionId))
      .orderBy(asc(tables.conversations.caseKey), asc(tables.conversations.seq));
    return rows.map(conversationSummary);
  }

  async getConversation(principal: CandidatePrincipal, conversationId: string): Promise<ConversationDetailResponse> {
    const conversation = await this.ownedConversation(principal, conversationId);
    const exam = await this.catalog.get(principal.examId);
    const rows = await this.db.select().from(tables.messages).where(eq(tables.messages.conversationId, conversationId)).orderBy(asc(tables.messages.seq));
    const attachmentRows = await this.attachmentsOf(rows.map((r) => r.id));
    const titles = materialTitleMap(exam.definition);
    return {
      conversation: conversationSummary(conversation),
      messages: rows.map((m) => messageView(m, attachmentRows, titles)),
      streaming: await this.hub.isBusy(conversationId),
    };
  }

  /** 같은 Case의 활성 대화를 닫고 새 대화를 연다(결정 D4) */
  async createConversation(principal: CandidatePrincipal, caseKey: string): Promise<ConversationSummary> {
    const session = await this.sessions.requireWritable(principal.candidateId);
    this.catalog.findCase(await this.catalog.get(session.examId), caseKey);
    const active = await this.db
      .select({ id: tables.conversations.id })
      .from(tables.conversations)
      .where(and(eq(tables.conversations.examSessionId, session.id), eq(tables.conversations.caseKey, caseKey), eq(tables.conversations.status, 'active')));
    for (const conversation of active) {
      if (await this.hub.isBusy(conversation.id)) throw appErrors.conflict('response_in_progress', 'AI가 답하는 중에는 새 대화를 시작할 수 없습니다');
    }
    return this.db.transaction(async (tx) => {
      await this.sessions.lockActive(tx, session.id);
      const now = this.clock.now();
      await tx
        .update(tables.conversations)
        .set({ status: 'closed', closedAt: now })
        .where(and(eq(tables.conversations.examSessionId, session.id), eq(tables.conversations.caseKey, caseKey), eq(tables.conversations.status, 'active')));
      const [last] = await tx
        .select({ value: max(tables.conversations.seq) })
        .from(tables.conversations)
        .where(and(eq(tables.conversations.examSessionId, session.id), eq(tables.conversations.caseKey, caseKey)));
      const [created] = await tx
        .insert(tables.conversations)
        .values({ examSessionId: session.id, caseKey, seq: (last?.value ?? 0) + 1, status: 'active' })
        .returning();
      if (created === undefined) throw new Error('대화를 만들지 못했습니다');
      return conversationSummary(created);
    });
  }

  async sendMessage(principal: CandidatePrincipal, conversationId: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    const session = await this.sessions.requireWritable(principal.candidateId);
    if (!(await this.limiter.tryAcquire(session.id))) {
      throw appErrors.tooManyRequests('ai_rate_limited', 'AI 요청이 너무 잦습니다. 잠시 후 다시 보내십시오');
    }
    const conversation = await this.ownedConversation(principal, conversationId);
    if (conversation.status !== 'active') throw appErrors.conflict('conversation_closed', '끝난 대화입니다. 현재 대화에서 이어가십시오');
    const exam = await this.catalog.get(session.examId);
    const caseDef = this.catalog.findCase(exam, conversation.caseKey);
    if (request.subquestionKey !== null && !caseDef.subquestions.some((s) => s.key === request.subquestionKey)) {
      throw appErrors.badRequest('invalid_subquestion', '이 Case의 하위문항이 아닙니다');
    }
    const [duplicate] = await this.db
      .select({ id: tables.messages.id })
      .from(tables.messages)
      .where(and(eq(tables.messages.conversationId, conversationId), eq(tables.messages.clientMessageId, request.clientMessageId)))
      .limit(1);
    if (duplicate !== undefined) throw appErrors.conflict('duplicate_message', '이미 보낸 메시지입니다');
    if (!(await this.hub.tryReserve(conversationId))) {
      throw appErrors.conflict('response_in_progress', 'AI가 이전 요청에 답하는 중입니다. 답변이 끝난 뒤 보내십시오');
    }

    let started = false;
    try {
      const { rendered, attachmentRecords, storedBlocks, newMessage } = await this.buildOutgoing(exam, conversation.caseKey, request);
      const history = await buildConversationHistory(this.db, conversationId);
      const settings = exam.definition.ai;

      const charged = await this.ai.countTokens({ model: settings.model, systemPrompt: null, messages: [newMessage] });
      const contextTokens = await this.ai.countTokens({ model: settings.model, systemPrompt: settings.systemPrompt, messages: [...history, newMessage] });
      if (contextTokens > exam.definition.contextTokenLimit) {
        throw appErrors.conflict(
          'context_limit_exceeded',
          `이 대화가 길어져 한 번에 보낼 수 있는 분량(${exam.definition.contextTokenLimit.toLocaleString('ko-KR')} 토큰)을 넘습니다. 새 대화를 시작하십시오. 토큰은 차감되지 않았습니다`,
          { contextTokens, limit: exam.definition.contextTokenLimit },
        );
      }
      const patternHits = findPatternHits([request.text, ...rendered.map((r) => r.renderedText ?? '')].join('\n'), exam.grading.patterns);

      const { userMessage, savedAttachments, balanceAfter } = await this.persistUserMessage({
        sessionId: session.id,
        conversationId,
        request,
        storedBlocks,
        attachmentRecords,
        rendered,
        charged,
        contextTokens,
        patternHits,
        settings,
        actor: actorOf.candidate(principal.candidateId),
      });

      const titles = materialTitleMap(exam.definition);
      this.hub.begin(conversationId);
      started = true;
      void this.complete({
        conversationId,
        examSessionId: session.id,
        subquestionKey: request.subquestionKey,
        settings,
        messages: [...history, newMessage],
        materialTitles: titles,
      });
      return { userMessage: messageView(userMessage, savedAttachments, titles), charged, contextTokens, tokenBalance: balanceAfter };
    } finally {
      if (!started) await this.hub.release(conversationId);
    }
  }

  /** 첨부를 렌더링하고, 저장할 블록과 API로 보낼 새 사용자 메시지를 만든다 */
  private async buildOutgoing(exam: ExamRecord, caseKey: string, request: SendMessageRequest) {
    const rendered: RenderedAttachment[] = [];
    for (const spec of request.attachments) rendered.push(await this.materials.render(exam, caseKey, spec));
    const attachmentRecords = rendered.map((r) => ({
      id: randomUUID(),
      materialKey: r.materialKey,
      selection: r.selection,
      renderedText: r.renderedText,
      blobSha256: r.pdf?.sha256 ?? null,
      documentTitle: r.pdf?.documentTitle ?? null,
    }));
    // 문서·자료를 본문보다 앞에 둔다(Claude 문서 권장 순서)
    const storedBlocks: StoredUserBlock[] = [
      ...attachmentRecords.map((a) => ({ type: 'attachment' as const, attachmentId: a.id })),
      ...(request.text.trim().length > 0 ? [{ type: 'text' as const, text: request.text }] : []),
    ];
    const payloads = new Map<string, AttachmentPayload>(
      attachmentRecords.map((a, i) => [a.id, { attachment: a, pdfBytes: rendered[i]?.pdf?.bytes ?? null }]),
    );
    const newMessage: Anthropic.MessageParam = { role: 'user', content: userBlocksToApi(storedBlocks, payloads) };
    return { rendered, attachmentRecords, storedBlocks, newMessage };
  }

  private async persistUserMessage(input: {
    sessionId: string;
    conversationId: string;
    request: SendMessageRequest;
    storedBlocks: StoredUserBlock[];
    attachmentRecords: Array<{ id: string; materialKey: string; selection: AttachmentRecord['selection']; renderedText: string | null; blobSha256: string | null; documentTitle: string | null }>;
    rendered: RenderedAttachment[];
    charged: number;
    contextTokens: number;
    patternHits: ReturnType<typeof findPatternHits>;
    settings: AiSettings;
    actor: string;
  }): Promise<{ userMessage: MessageRecord; savedAttachments: AttachmentRecord[]; balanceAfter: number }> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.sessions.lockActive(tx, input.sessionId);
        // 새 대화 시작(createConversation)도 같은 세션 행을 잠그므로, 잠금을 잡은 뒤 대화가 아직 진행 중인지 다시 본다
        const [conversation] = await tx
          .select({ status: tables.conversations.status })
          .from(tables.conversations)
          .where(eq(tables.conversations.id, input.conversationId));
        if (conversation?.status !== 'active') throw appErrors.conflict('conversation_closed', '그사이 이 대화가 닫혔습니다. 현재 대화에서 다시 보내십시오. 토큰은 차감되지 않았습니다');
        const balance = await this.ledger.balance(tx, input.sessionId);
        if (balance < input.charged) throw insufficientTokens(balance, input.charged);
        const [userMessage] = await tx
          .insert(tables.messages)
          .values({
            conversationId: input.conversationId,
            examSessionId: input.sessionId,
            seq: await nextMessageSeq(tx, input.conversationId),
            role: 'user',
            subquestionKey: input.request.subquestionKey,
            clientMessageId: input.request.clientMessageId,
            content: input.storedBlocks,
            plainText: input.request.text,
            chargedTokens: input.charged,
            contextTokens: input.contextTokens,
            patternHits: input.patternHits,
            provider: this.ai.provider,
            model: input.settings.model,
            status: 'complete',
          })
          .returning();
        if (userMessage === undefined) throw new Error('메시지를 저장하지 못했습니다');
        for (const r of input.rendered) {
          if (r.pdf !== null) {
            await tx.insert(tables.attachmentBlobs).values({ sha256: r.pdf.sha256, bytes: r.pdf.bytes, byteLength: r.pdf.bytes.byteLength }).onConflictDoNothing();
          }
        }
        const savedAttachments =
          input.attachmentRecords.length === 0
            ? []
            : await tx
                .insert(tables.attachments)
                .values(input.attachmentRecords.map((a) => ({ ...a, messageId: userMessage.id, examSessionId: input.sessionId })))
                .returning();
        const balanceAfter = await this.ledger.charge(tx, { examSessionId: input.sessionId, messageId: userMessage.id, amount: input.charged, actor: input.actor });
        return { userMessage, savedAttachments, balanceAfter };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw appErrors.conflict('duplicate_message', '이미 보낸 메시지입니다');
      throw error;
    }
  }

  /** 백그라운드에서 AI 응답을 받아 저장한다. 어떤 경우에도 스트림 허브를 정리한다 */
  private async complete(context: CompletionContext): Promise<void> {
    const startedAt = performance.now();
    try {
      const completion = await this.ai.streamConversation(
        {
          model: context.settings.model,
          maxTokens: context.settings.maxTokens,
          effort: context.settings.effort,
          systemPrompt: context.settings.systemPrompt,
          messages: context.messages,
        },
        (delta) => this.hub.append(context.conversationId, delta),
      );
      const record = await this.insertAssistant(context, {
        status: 'complete',
        content: completion.content,
        plainText: assistantPlainText(completion.content),
        stopReason: completion.stopReason,
        usage: completion.usage,
        latencyMs: Math.round(performance.now() - startedAt),
        providerRequestId: completion.requestId,
        providerMessageId: completion.providerMessageId,
        model: completion.model,
        error: null,
      });
      await this.hub.finish(context.conversationId, { event: 'done', data: { message: messageView(record, [], context.materialTitles) } });
    } catch (error) {
      const failure = error instanceof AiGatewayError ? error : new AiGatewayError(error instanceof Error ? error.message : String(error), 'unknown', null);
      this.logger.error('ai_completion_failed', { conversationId: context.conversationId, kind: failure.kind, status: failure.status, error });
      try {
        const record = await this.insertAssistant(context, {
          status: 'error',
          content: [],
          plainText: '',
          stopReason: null,
          usage: null,
          latencyMs: Math.round(performance.now() - startedAt),
          providerRequestId: null,
          providerMessageId: null,
          model: context.settings.model,
          error: { type: failure.kind, message: failure.message, status: failure.status },
        });
        await this.hub.finish(context.conversationId, { event: 'failed', data: { message: messageView(record, [], context.materialTitles), reason: AI_FAILURE_MESSAGES[failure.kind] } });
      } catch (recordError) {
        this.logger.error('ai_error_record_failed', { conversationId: context.conversationId, error: recordError });
        await this.hub.finish(context.conversationId, { event: 'failed', data: { message: null, reason: '응답을 기록하지 못했습니다. 감독관에게 알리십시오.' } });
      }
    }
  }

  private async insertAssistant(
    context: CompletionContext,
    values: Pick<MessageRecord, 'status' | 'plainText' | 'stopReason' | 'usage' | 'latencyMs' | 'providerRequestId' | 'providerMessageId' | 'model' | 'error'> & { content: unknown[] },
  ): Promise<MessageRecord> {
    const [record] = await this.db
      .insert(tables.messages)
      .values({
        ...values,
        conversationId: context.conversationId,
        examSessionId: context.examSessionId,
        seq: await nextMessageSeq(this.db, context.conversationId),
        role: 'assistant',
        subquestionKey: context.subquestionKey,
        provider: this.ai.provider,
      })
      .returning();
    if (record === undefined) throw new Error('AI 응답을 저장하지 못했습니다');
    return record;
  }

  private async attachmentsOf(messageIds: readonly string[]): Promise<AttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    return this.db.select().from(tables.attachments).where(inArray(tables.attachments.messageId, [...messageIds]));
  }
}
