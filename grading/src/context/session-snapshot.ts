import { tables, type AttachmentSelection, type Database } from '@ai-measurement/infra';
import type { AnswerContent } from '@ai-measurement/shared';
import { asc, eq } from 'drizzle-orm';

/** 채점이 보는 메시지 한 건. sentText는 실제로 AI에 간 텍스트(본문 + CSV 첨부 본문)다 */
export interface GradingMessage {
  id: string;
  conversationId: string;
  conversationSeq: number;
  caseKey: string;
  seq: number;
  role: 'user' | 'assistant';
  status: 'complete' | 'error';
  createdAt: Date;
  subquestionKey: string | null;
  text: string;
  sentText: string;
  chargedTokens: number | null;
  attachments: Array<{ materialKey: string; selection: AttachmentSelection }>;
}

export interface GradingAnswerVersion {
  subquestionKey: string;
  version: number;
  content: AnswerContent;
  isFinal: boolean;
  source: 'candidate_save' | 'candidate_submit' | 'auto_final_on_end';
  savedAt: Date;
}

export interface SessionSnapshot {
  sessionId: string;
  candidateNo: string;
  startedAt: Date;
  endedAt: Date;
  messages: GradingMessage[];
  answers: GradingAnswerVersion[];
  /** 응시자가 직접 최종 제출한 최초 시각(하위문항별) */
  firstSubmissionAt: Map<string, Date>;
}

/** 종료된 응시 세션 하나의 채점 입력을 읽는다 */
export async function loadSessionSnapshot(db: Database, examSessionId: string): Promise<SessionSnapshot> {
  const [row] = await db
    .select({ session: tables.examSessions, candidateNo: tables.candidates.candidateNo })
    .from(tables.examSessions)
    .innerJoin(tables.candidates, eq(tables.candidates.id, tables.examSessions.candidateId))
    .where(eq(tables.examSessions.id, examSessionId))
    .limit(1);
  if (row === undefined) throw new Error(`응시 세션이 없습니다: ${examSessionId}`);
  if (row.session.endedAt === null) throw new Error(`아직 끝나지 않은 세션은 채점하지 않습니다: ${examSessionId}`);

  const conversations = await db.select().from(tables.conversations).where(eq(tables.conversations.examSessionId, examSessionId));
  const conversationById = new Map(conversations.map((c) => [c.id, c]));
  const messageRows = await db.select().from(tables.messages).where(eq(tables.messages.examSessionId, examSessionId)).orderBy(asc(tables.messages.createdAt), asc(tables.messages.seq));
  const attachmentRows = await db.select().from(tables.attachments).where(eq(tables.attachments.examSessionId, examSessionId));

  const messages: GradingMessage[] = messageRows.map((m) => {
    const conversation = conversationById.get(m.conversationId);
    if (conversation === undefined) throw new Error(`메시지의 대화가 없습니다: ${m.id}`);
    const attachments = attachmentRows.filter((a) => a.messageId === m.id);
    const renderedCsv = attachments.flatMap((a) => (a.renderedText !== null ? [a.renderedText] : []));
    return {
      id: m.id,
      conversationId: m.conversationId,
      conversationSeq: conversation.seq,
      caseKey: conversation.caseKey,
      seq: m.seq,
      role: m.role,
      status: m.status,
      createdAt: m.createdAt,
      subquestionKey: m.subquestionKey,
      text: m.plainText,
      sentText: [m.plainText, ...renderedCsv].join('\n'),
      chargedTokens: m.chargedTokens,
      attachments: attachments.map((a) => ({ materialKey: a.materialKey, selection: a.selection })),
    };
  });

  const answers = await db
    .select()
    .from(tables.answers)
    .where(eq(tables.answers.examSessionId, examSessionId))
    .orderBy(asc(tables.answers.subquestionKey), asc(tables.answers.version));
  const firstSubmissionAt = new Map<string, Date>();
  for (const a of answers) {
    if (a.source === 'candidate_submit' && !firstSubmissionAt.has(a.subquestionKey)) firstSubmissionAt.set(a.subquestionKey, a.savedAt);
  }

  return {
    sessionId: examSessionId,
    candidateNo: row.candidateNo,
    startedAt: row.session.startedAt,
    endedAt: row.session.endedAt,
    messages,
    answers: answers.map((a) => ({ subquestionKey: a.subquestionKey, version: a.version, content: a.content, isFinal: a.isFinal, source: a.source, savedAt: a.savedAt })),
    firstSubmissionAt,
  };
}

/** 하위문항의 최종 답안(가장 최근 최종본). 없으면 null */
export function finalAnswer(snapshot: SessionSnapshot, subquestionKey: string): GradingAnswerVersion | null {
  const finals = snapshot.answers.filter((a) => a.subquestionKey === subquestionKey && a.isFinal);
  return finals.at(-1) ?? null;
}
