import { z } from 'zod';
import { answerContentSchema, type AnswerContent } from '../answers/answer-content';
import { keySchema } from '../exam-package/common-schema';
import type { AnswerFormat, MaterialKind, SubquestionDefinition } from '../exam-package/exam-definition-schema';

/** 응시자 메시지 본문의 최대 글자 수. 비정상 입력을 막는 시스템 한도이며 토큰 예산과는 별개다 */
export const MAX_MESSAGE_CHARS = 200_000;
/** 메시지 하나에 붙일 수 있는 첨부 수 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export type AiProviderName = 'anthropic' | 'mock';
export type ExamStatusName = 'draft' | 'open' | 'closed';
export type ExamSessionStatusName = 'active' | 'submitted' | 'expired';

export const candidateLoginRequestSchema = z.strictObject({
  candidateNo: z.string().trim().min(1).max(40),
  pin: z.string().trim().regex(/^\d{4,12}$/u, 'PIN은 숫자여야 합니다'),
});
export type CandidateLoginRequest = z.infer<typeof candidateLoginRequestSchema>;

export const attachmentSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('csv'),
    materialKey: keySchema,
    columns: z.array(z.string().min(1)).min(1).max(200),
    rowIndexes: z.array(z.number().int().min(0)).min(1).max(100_000),
  }),
  z.strictObject({
    kind: z.literal('pdf'),
    materialKey: keySchema,
    pageFrom: z.number().int().min(1),
    pageTo: z.number().int().min(1),
  }),
]);
export type AttachmentSpec = z.infer<typeof attachmentSpecSchema>;

export const sendMessageRequestSchema = z
  .strictObject({
    clientMessageId: z.uuid(),
    subquestionKey: keySchema.nullable(),
    text: z.string().max(MAX_MESSAGE_CHARS),
    attachments: z.array(attachmentSpecSchema).max(MAX_ATTACHMENTS_PER_MESSAGE),
  })
  .refine((value) => value.text.trim().length > 0 || value.attachments.length > 0, {
    message: '본문이나 첨부 중 하나는 있어야 합니다',
  });
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const saveAnswerRequestSchema = z.strictObject({ content: answerContentSchema });
export type SaveAnswerRequest = z.infer<typeof saveAnswerRequestSchema>;

export const clientEventRequestSchema = z.strictObject({
  kind: z.enum(['subquestion_enter', 'subquestion_leave', 'tab_hidden', 'tab_visible']),
  subquestionKey: keySchema.nullable(),
});
export type ClientEventRequest = z.infer<typeof clientEventRequestSchema>;

export interface CandidateMaterialView {
  key: string;
  title: string;
  kind: MaterialKind;
}

export type CandidateSubquestionView = Pick<SubquestionDefinition, 'key' | 'title' | 'type' | 'prompt'> & {
  answer: AnswerFormat;
  /** 문항 아래 유의사항(없으면 빈 배열) */
  guidance: string[];
};

export interface CandidateNoticeView {
  key: string;
  from: string;
  title: string;
  body: string;
  revealedAt: string;
}

export interface CandidateCaseView {
  key: string;
  title: string;
  brief: string;
  materials: CandidateMaterialView[];
  subquestions: CandidateSubquestionView[];
  notices: CandidateNoticeView[];
}

export interface CandidateAnswerView {
  subquestionKey: string;
  version: number;
  content: AnswerContent;
  savedAt: string;
  /** 가장 최근 최종 제출 시각. 제출한 적 없으면 null */
  lastSubmittedAt: string | null;
  /** 가장 최근 버전이 최종 제출본인지 */
  latestIsFinal: boolean;
}

export interface ConversationSummary {
  id: string;
  caseKey: string;
  seq: number;
  status: 'active' | 'closed';
  createdAt: string;
}

export interface CandidateSessionView {
  id: string;
  status: ExamSessionStatusName;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  tokenBudget: number;
  tokenBalance: number;
}

export interface CandidateStateResponse {
  serverNow: string;
  aiProvider: AiProviderName;
  candidateNo: string;
  exam: {
    title: string;
    status: ExamStatusName;
    candidateNotice: string;
    durationMinutes: number;
    tokenBudget: number;
    contextTokenLimit: number;
    caseCount: number;
  };
  session: CandidateSessionView | null;
  /** 시험을 시작하기 전에는 비어 있다 */
  cases: CandidateCaseView[];
  answers: CandidateAnswerView[];
  conversations: ConversationSummary[];
}

export type AttachmentSelectionView =
  | { kind: 'csv'; columns: string[]; rowCount: number }
  | { kind: 'pdf'; pageFrom: number; pageTo: number };

export interface ChatAttachmentView {
  id: string;
  materialKey: string;
  materialTitle: string;
  selection: AttachmentSelectionView;
}

export interface ChatMessageView {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  subquestionKey: string | null;
  text: string;
  attachments: ChatAttachmentView[];
  chargedTokens: number | null;
  status: 'complete' | 'error';
  stopReason: string | null;
  errorMessage: string | null;
  provider: AiProviderName;
  createdAt: string;
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
  messages: ChatMessageView[];
  /** 응답을 만들고 있는 중이면 true. /progress로 지금까지의 텍스트를 받는다 */
  streaming: boolean;
}

/**
 * 진행 중인 AI 응답의 지금까지 텍스트(짧은 요청으로 반복해서 읽는다).
 * Firebase Hosting은 SSE 응답을 끝까지 모아 한꺼번에 보내므로(2026-09-27 확인) 화면은 SSE 대신 이것을 쓴다.
 */
export interface ConversationProgressResponse {
  streaming: boolean;
  /** 응답 중이면 지금까지의 텍스트, 아니면 null(화면은 대화를 다시 읽어 저장된 응답을 본다) */
  text: string | null;
}

export interface SendMessageResponse {
  userMessage: ChatMessageView;
  charged: number;
  contextTokens: number;
  tokenBalance: number;
}

export interface SaveAnswerResponse {
  answer: CandidateAnswerView;
  /** 이 저장으로 새로 열린 공지 */
  newlyRevealedNotices: CandidateNoticeView[];
}

export type MaterialPreviewResponse =
  | { kind: 'csv'; headers: string[]; rows: string[][] }
  | { kind: 'pdf'; pageCount: number };

/** SSE 이벤트 이름과 데이터 */
export type ChatStreamEvent =
  | { event: 'snapshot'; data: { text: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: { message: ChatMessageView } }
  /**
   * AI 응답 실패. message는 오류를 기록한 AI 메시지이고, 기록마저 실패했으면 null.
   * 이벤트 이름을 'error'로 하지 않는 이유: 브라우저 EventSource의 연결 오류 이벤트와 이름이 겹친다
   */
  | { event: 'failed'; data: { message: ChatMessageView | null; reason: string } }
  | { event: 'idle'; data: Record<string, never> }
  | { event: 'ping'; data: Record<string, never> };
