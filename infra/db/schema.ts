import type {
  AnswerContent,
  AnswerKey,
  Axis,
  ExamDefinition,
  GradingConfig,
  PatternHit,
  Rubric,
} from '@ai-measurement/shared';
import {
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * PRD 11장 저장 데이터를 담는 스키마.
 * 대화(messages), 토큰 원장(token_ledger), 답안(answers), 이벤트는 추가만 하고 고치지 않는다.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export type ExamStatus = 'draft' | 'open' | 'closed';
export type ExamSessionStatus = 'active' | 'submitted' | 'expired';
export type PrincipalType = 'candidate' | 'admin';
export type AiProviderName = 'anthropic' | 'mock';

export interface MaterialFileSnapshot {
  key: string;
  kind: 'csv' | 'pdf';
  file: string;
  sha256: string;
  byteLength: number;
}

export const admins = pgTable('admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const exams = pgTable('exams', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  status: text('status').$type<ExamStatus>().notNull(),
  packageSha256: text('package_sha256').notNull(),
  definition: jsonb('definition').$type<ExamDefinition>().notNull(),
  grading: jsonb('grading').$type<GradingConfig>().notNull(),
  rubrics: jsonb('rubrics').$type<Record<string, Rubric>>().notNull(),
  answerKeys: jsonb('answer_keys').$type<Record<string, AnswerKey>>().notNull(),
  materialFiles: jsonb('material_files').$type<Record<string, MaterialFileSnapshot>>().notNull(),
  importedBy: uuid('imported_by').notNull().references(() => admins.id),
  importedAt: tsz('imported_at').notNull().defaultNow(),
  openedAt: tsz('opened_at'),
  closedAt: tsz('closed_at'),
});

export const candidates = pgTable(
  'candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    examId: uuid('exam_id').notNull().references(() => exams.id),
    candidateNo: text('candidate_no').notNull(),
    pinHash: text('pin_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('candidates_candidate_no_uq').on(t.candidateNo), index('candidates_exam_idx').on(t.examId)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    principalType: text('principal_type').$type<PrincipalType>().notNull(),
    principalId: uuid('principal_id').notNull(),
    createdAt: createdAt(),
    expiresAt: tsz('expires_at').notNull(),
    revokedAt: tsz('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('auth_sessions_principal_idx').on(t.principalType, t.principalId)],
);

export const examSessions = pgTable(
  'exam_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    examId: uuid('exam_id').notNull().references(() => exams.id),
    candidateId: uuid('candidate_id').notNull().references(() => candidates.id),
    status: text('status').$type<ExamSessionStatus>().notNull(),
    startedAt: tsz('started_at').notNull(),
    expiresAt: tsz('expires_at').notNull(),
    endedAt: tsz('ended_at'),
    tokenBudget: integer('token_budget').notNull(),
  },
  (t) => [uniqueIndex('exam_sessions_candidate_uq').on(t.candidateId), index('exam_sessions_exam_idx').on(t.examId, t.status)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    caseKey: text('case_key').notNull(),
    seq: integer('seq').notNull(),
    status: text('status').$type<'active' | 'closed'>().notNull(),
    createdAt: createdAt(),
    closedAt: tsz('closed_at'),
  },
  (t) => [uniqueIndex('conversations_seq_uq').on(t.examSessionId, t.caseKey, t.seq)],
);

/** 사용자 메시지에 저장하는 본문 블록. 첨부는 id로 참조하고 전송 시점에 실제 블록으로 바꾼다 */
export type StoredUserBlock = { type: 'text'; text: string } | { type: 'attachment'; attachmentId: string };

export interface ApiUsageRecord {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    seq: integer('seq').notNull(),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    subquestionKey: text('subquestion_key'),
    clientMessageId: text('client_message_id'),
    /** user: StoredUserBlock[] / assistant: API가 돌려준 content 블록 그대로(thinking 블록 포함) */
    content: jsonb('content').$type<unknown[]>().notNull(),
    plainText: text('plain_text').notNull(),
    chargedTokens: integer('charged_tokens'),
    contextTokens: integer('context_tokens'),
    patternHits: jsonb('pattern_hits').$type<PatternHit[]>(),
    provider: text('provider').$type<AiProviderName>().notNull(),
    model: text('model').notNull(),
    status: text('status').$type<'complete' | 'error'>().notNull(),
    stopReason: text('stop_reason'),
    usage: jsonb('usage').$type<ApiUsageRecord>(),
    latencyMs: integer('latency_ms'),
    providerRequestId: text('provider_request_id'),
    providerMessageId: text('provider_message_id'),
    error: jsonb('error').$type<{ type: string; message: string; status: number | null }>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_seq_uq').on(t.conversationId, t.seq),
    uniqueIndex('messages_client_id_uq').on(t.conversationId, t.clientMessageId),
    index('messages_session_idx').on(t.examSessionId, t.createdAt),
  ],
);

export type AttachmentSelection =
  | { kind: 'csv'; columns: string[]; rowIndexes: number[] }
  | { kind: 'pdf'; pageFrom: number; pageTo: number };

export const attachmentBlobs = pgTable('attachment_blobs', {
  sha256: text('sha256').primaryKey(),
  bytes: bytea('bytes').notNull(),
  byteLength: integer('byte_length').notNull(),
  createdAt: createdAt(),
});

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').notNull().references(() => messages.id),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    materialKey: text('material_key').notNull(),
    selection: jsonb('selection').$type<AttachmentSelection>().notNull(),
    /** CSV: AI에 보낸 텍스트 그대로 */
    renderedText: text('rendered_text'),
    /** PDF: 보낸 PDF 바이트의 해시(attachment_blobs 참조) */
    blobSha256: text('blob_sha256').references(() => attachmentBlobs.sha256),
    /** PDF: 보낸 document 블록의 title. 다시 보낼 때 같은 바이트가 되도록 저장한다 */
    documentTitle: text('document_title'),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_session_idx').on(t.examSessionId), index('attachments_message_idx').on(t.messageId)],
);

export const tokenLedger = pgTable(
  'token_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    messageId: uuid('message_id').references(() => messages.id),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason').$type<'initial' | 'message' | 'refund'>().notNull(),
    note: text('note'),
    actor: text('actor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('token_ledger_session_idx').on(t.examSessionId, t.id)],
);

export type AnswerSource = 'candidate_save' | 'candidate_submit' | 'auto_final_on_end';

export const answers = pgTable(
  'answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    subquestionKey: text('subquestion_key').notNull(),
    version: integer('version').notNull(),
    content: jsonb('content').$type<AnswerContent>().notNull(),
    isFinal: boolean('is_final').notNull(),
    source: text('source').$type<AnswerSource>().notNull(),
    savedAt: tsz('saved_at').notNull(),
  },
  (t) => [uniqueIndex('answers_version_uq').on(t.examSessionId, t.subquestionKey, t.version)],
);

export type ClientEventKind = 'subquestion_enter' | 'subquestion_leave' | 'tab_hidden' | 'tab_visible';

export const clientEvents = pgTable(
  'client_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    kind: text('kind').$type<ClientEventKind>().notNull(),
    subquestionKey: text('subquestion_key'),
    at: tsz('at').notNull(),
  },
  (t) => [index('client_events_session_idx').on(t.examSessionId, t.at)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    examId: uuid('exam_id'),
    examSessionId: uuid('exam_session_id'),
    actor: text('actor').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_session_idx').on(t.examSessionId, t.id), index('audit_events_exam_idx').on(t.examId, t.id)],
);

export type GradingJobStatus = 'queued' | 'running' | 'waiting_batch' | 'done' | 'failed';
export type LlmMode = 'direct' | 'batch';

export const gradingJobs = pgTable(
  'grading_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    examId: uuid('exam_id').notNull().references(() => exams.id),
    status: text('status').$type<GradingJobStatus>().notNull(),
    llmMode: text('llm_mode').$type<LlmMode>().notNull(),
    llmProvider: text('llm_provider').$type<AiProviderName>().notNull(),
    requestedBy: uuid('requested_by').notNull().references(() => admins.id),
    createdAt: createdAt(),
    startedAt: tsz('started_at'),
    finishedAt: tsz('finished_at'),
    lockedUntil: tsz('locked_until'),
    batchId: text('batch_id'),
    /** Batches custom_id → 채점 대상(세션·Case) */
    batchRequests: jsonb('batch_requests').$type<Record<string, { examSessionId: string; caseKey: string }>>(),
    error: text('error'),
    progress: jsonb('progress').$type<{ sessionsTotal: number; sessionsGraded: number; skippedActive: number }>(),
  },
  (t) => [index('grading_jobs_status_idx').on(t.status, t.createdAt)],
);

export type GradeItemStatus = 'graded' | 'ungraded';
export type GraderKind = 'rule' | 'llm' | 'llm-mock';

export const gradeItems = pgTable(
  'grade_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gradingJobId: uuid('grading_job_id').notNull().references(() => gradingJobs.id),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    caseKey: text('case_key').notNull(),
    axis: text('axis').$type<Axis>().notNull(),
    itemId: text('item_id').notNull(),
    itemKind: text('item_kind').$type<'rule' | 'criterion'>().notNull(),
    description: text('description').notNull(),
    points: doublePrecision('points').notNull(),
    earned: doublePrecision('earned'),
    status: text('status').$type<GradeItemStatus>().notNull(),
    grader: text('grader').$type<GraderKind>().notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    rubricVersion: text('rubric_version').notNull(),
    model: text('model'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('grade_items_uq').on(t.gradingJobId, t.examSessionId, t.caseKey, t.itemId),
    index('grade_items_session_idx').on(t.examSessionId),
  ],
);

export type SessionOutcome = 'clear' | 'flagged' | 'review' | 'fail';

export const sessionScores = pgTable(
  'session_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gradingJobId: uuid('grading_job_id').notNull().references(() => gradingJobs.id),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    status: text('status').$type<'graded' | 'incomplete'>().notNull(),
    /** 가중 총점(0~100). 미채점 항목이 있으면 null */
    total: doublePrecision('total'),
    /** 축별 득점률(0~100). 미채점 항목이 있는 축은 null */
    axisPercent: jsonb('axis_percent').$type<Record<Axis, number | null>>().notNull(),
    violationCount: integer('violation_count').notNull(),
    outcome: text('outcome').$type<SessionOutcome>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('session_scores_uq').on(t.gradingJobId, t.examSessionId)],
);

export const violations = pgTable(
  'violations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gradingJobId: uuid('grading_job_id').notNull().references(() => gradingJobs.id),
    examSessionId: uuid('exam_session_id').notNull().references(() => examSessions.id),
    messageId: uuid('message_id').references(() => messages.id),
    source: text('source').$type<'column' | 'row' | 'page' | 'pattern'>().notNull(),
    tag: text('tag').notNull(),
    label: text('label').notNull(),
    count: integer('count').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('violations_session_idx').on(t.examSessionId)],
);

/**
 * 수험생 서버 여러 대가 대화별 AI 응답 진행을 조정하는 임시 상태(결정: 2026-09-27 수험생 서버 다중 인스턴스).
 * 기록이 아니다. 응답이 끝나면 terminal에 끝 이벤트를 남기고, 잠시 뒤 지운다. 대화 기록은 messages에 있다.
 */
export const aiStreams = pgTable('ai_streams', {
  conversationId: uuid('conversation_id')
    .primaryKey()
    .references(() => conversations.id),
  /** 응답을 맡은 서버 프로세스 식별자(기동할 때마다 새로 만든다) */
  instanceId: text('instance_id').notNull(),
  /** 다른 서버가 요청했을 때 맡은 서버가 써 주는 지금까지의 텍스트 */
  snapshot: text('snapshot'),
  /** 끝 이벤트(done·failed). 다른 서버의 구독자는 알림을 받고 이 값을 읽는다 */
  terminal: jsonb('terminal').$type<unknown>(),
  reservedAt: tsz('reserved_at').notNull(),
  /** 맡은 서버가 살아 있다는 표시. 오래 갱신되지 않으면 버려진 예약으로 본다 */
  heartbeatAt: tsz('heartbeat_at').notNull(),
  finishedAt: tsz('finished_at'),
});

/**
 * 요청 한도·로그인 잠금 기록(슬라이딩 윈도). 수험생 서버 여러 대가 같은 한도를 나눠 쓰도록 DB에 둔다.
 * bucket 예: 'ai:<응시 세션>', 'login-ip:<주소>', 'login-fail:<응시번호>'. 창을 벗어난 행은 주기적으로 지운다.
 */
export const rateLimitHits = pgTable(
  'rate_limit_hits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    bucket: text('bucket').notNull(),
    at: tsz('at').notNull(),
  },
  (t) => [index('rate_limit_hits_bucket_at_idx').on(t.bucket, t.at)],
);
