import { z } from 'zod';
import type { Axis } from '../axes';
import type { AnswerContent } from '../answers/answer-content';
import { keySchema, type PackageIssue } from '../exam-package/common-schema';
import type { ExamDefinition } from '../exam-package/exam-definition-schema';
import type {
  AiProviderName,
  AttachmentSelectionView,
  ChatMessageView,
  ConversationSummary,
  ExamSessionStatusName,
  ExamStatusName,
} from './candidate-api';

export const adminLoginRequestSchema = z.strictObject({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

export const importDirectoryRequestSchema = z.strictObject({ slug: keySchema });

export const examStatusChangeRequestSchema = z.strictObject({ status: z.enum(['open', 'closed']) });

export const generateCandidatesRequestSchema = z.strictObject({
  prefix: z.string().regex(/^[A-Z0-9]{1,8}$/u, '접두사는 대문자 영문·숫자 1~8자입니다'),
  count: z.number().int().min(1).max(1000),
});

export const extendSessionRequestSchema = z.strictObject({
  minutes: z.number().int().min(1).max(240),
  reason: z.string().trim().min(1).max(500),
});

export const refundRequestSchema = z.strictObject({
  messageId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
});

export const createGradingJobRequestSchema = z.strictObject({ llmMode: z.enum(['direct', 'batch']) });

export interface AdminMeResponse {
  username: string;
}

export interface ExamPackageListItem {
  slug: string;
  ok: boolean;
  title: string | null;
  issues: PackageIssue[];
  importedExamId: string | null;
}

export interface ExamListItem {
  id: string;
  slug: string;
  title: string;
  status: ExamStatusName;
  candidateCount: number;
  sessionCounts: Record<ExamSessionStatusName, number>;
  importedAt: string;
}

export interface GeneratedCandidate {
  candidateNo: string;
  pin: string;
}

export interface SessionListItem {
  examSessionId: string | null;
  candidateNo: string;
  status: ExamSessionStatusName | 'not_started';
  startedAt: string | null;
  expiresAt: string | null;
  tokenUsed: number | null;
  score: SessionScoreView | null;
}

export interface SessionScoreView {
  gradingJobId: string;
  status: 'graded' | 'incomplete';
  total: number | null;
  axisPercent: Record<Axis, number | null>;
  violationCount: number;
  outcome: 'clear' | 'flagged' | 'review' | 'fail';
  graderKinds: string[];
}

export interface ExamDetailResponse {
  id: string;
  slug: string;
  title: string;
  status: ExamStatusName;
  packageSha256: string;
  definition: ExamDefinition;
  sessions: SessionListItem[];
  gradingJobs: GradingJobView[];
  /** 이 시험의 AI 응답 메시지에 기록된 공급자(중복 제거). 아직 대화가 없으면 빈 배열 */
  aiProvidersUsed: AiProviderName[];
  /** 관리자 서버가 채점 작업에 기록하는 LLM 공급자 */
  gradingLlmProvider: AiProviderName;
}

export interface GradingJobView {
  id: string;
  status: 'queued' | 'running' | 'waiting_batch' | 'done' | 'failed';
  llmMode: 'direct' | 'batch';
  llmProvider: AiProviderName;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  progress: { sessionsTotal: number; sessionsGraded: number; skippedActive: number } | null;
}

export interface LedgerEntryView {
  id: number;
  messageId: string | null;
  delta: number;
  balanceAfter: number;
  reason: 'initial' | 'message' | 'refund';
  note: string | null;
  actor: string;
  createdAt: string;
}

export interface AnswerVersionView {
  subquestionKey: string;
  version: number;
  content: AnswerContent;
  isFinal: boolean;
  source: 'candidate_save' | 'candidate_submit' | 'auto_final_on_end';
  savedAt: string;
}

export interface AdminMessageView extends ChatMessageView {
  contextTokens: number | null;
  patternHits: Array<{ patternId: string; count: number }>;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null } | null;
  latencyMs: number | null;
  model: string;
}

export interface AdminConversationView extends ConversationSummary {
  messages: AdminMessageView[];
}

export interface GradeItemView {
  caseKey: string;
  axis: Axis;
  itemId: string;
  itemKind: 'rule' | 'criterion';
  description: string;
  points: number;
  earned: number | null;
  status: 'graded' | 'ungraded';
  grader: string;
  detail: Record<string, unknown>;
}

export interface ViolationView {
  id: string;
  messageId: string | null;
  source: 'column' | 'row' | 'page' | 'pattern';
  tag: string;
  label: string;
  count: number;
}

export interface TimelineEventView {
  at: string;
  kind: string;
  subquestionKey: string | null;
  payload: Record<string, unknown>;
}

export interface AdminAttachmentView {
  id: string;
  messageId: string;
  materialKey: string;
  selection: AttachmentSelectionView;
}

export interface SessionDetailResponse {
  examId: string;
  examTitle: string;
  /** 시험 정의 순서의 Case 목록(화면 제목·순서용) */
  cases: Array<{ key: string; title: string }>;
  candidateNo: string;
  session: {
    id: string;
    status: ExamSessionStatusName;
    startedAt: string;
    expiresAt: string;
    endedAt: string | null;
    tokenBudget: number;
    tokenBalance: number;
  };
  conversations: AdminConversationView[];
  attachments: AdminAttachmentView[];
  ledger: LedgerEntryView[];
  answers: AnswerVersionView[];
  timeline: TimelineEventView[];
  latestScore: SessionScoreView | null;
  gradeItems: GradeItemView[];
  violations: ViolationView[];
}
