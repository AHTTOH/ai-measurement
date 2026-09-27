import type { AttachmentSelection } from '@ai-measurement/infra';
import type { CaseContext, GradingExam, GradingMessage, SessionSnapshot } from '@ai-measurement/grading';
import type { AnswerContent, MaterialFacts } from '@ai-measurement/shared';
import { loadSamplePackage } from '../shared/sample-package';

export const STARTED = new Date('2026-09-27T01:00:00Z');
export const minutes = (m: number) => new Date(STARTED.getTime() + m * 60_000);

let counter = 0;

export function userMessage(caseKey: string, text: string, options: { at?: Date; attachments?: Array<{ materialKey: string; selection: AttachmentSelection; renderedText?: string }> } = {}): GradingMessage {
  counter += 1;
  const attachments = options.attachments ?? [];
  return {
    id: `m-${counter}`,
    conversationId: `conv-${caseKey}`,
    conversationSeq: 1,
    caseKey,
    seq: counter,
    role: 'user',
    status: 'complete',
    createdAt: options.at ?? minutes(counter),
    subquestionKey: null,
    text,
    sentText: [text, ...attachments.flatMap((a) => (a.renderedText !== undefined ? [a.renderedText] : []))].join('\n'),
    chargedTokens: 10,
    attachments: attachments.map((a) => ({ materialKey: a.materialKey, selection: a.selection })),
  };
}

export function answer(subquestionKey: string, version: number, content: AnswerContent, source: 'candidate_save' | 'candidate_submit' | 'auto_final_on_end', at: Date) {
  return { subquestionKey, version, content, isFinal: source !== 'candidate_save', source, savedAt: at };
}

export function snapshotOf(messages: GradingMessage[], answers: SessionSnapshot['answers'] = []): SessionSnapshot {
  const firstSubmissionAt = new Map<string, Date>();
  for (const a of answers) if (a.source === 'candidate_submit' && !firstSubmissionAt.has(a.subquestionKey)) firstSubmissionAt.set(a.subquestionKey, a.savedAt);
  return { sessionId: 's-1', candidateNo: 'T0001', startedAt: STARTED, endedAt: minutes(120), messages, answers, firstSubmissionAt };
}

export async function sampleGradingExam(): Promise<{ exam: GradingExam; materials: Record<string, MaterialFacts> }> {
  const pkg = await loadSamplePackage();
  return {
    exam: { id: 'exam-1', slug: pkg.definition.slug, definition: pkg.definition, grading: pkg.grading, rubrics: pkg.rubrics, answerKeys: pkg.answerKeys },
    materials: pkg.materialFacts,
  };
}

export async function caseContext(caseKey: string, snapshot: SessionSnapshot): Promise<CaseContext> {
  const { exam, materials } = await sampleGradingExam();
  const caseDef = exam.definition.cases.find((c) => c.key === caseKey);
  const rubric = exam.rubrics[caseKey];
  const answerKey = exam.answerKeys[caseKey];
  if (caseDef === undefined || rubric === undefined || answerKey === undefined) throw new Error(`샘플에 ${caseKey}가 없습니다`);
  return { exam, caseDef, rubric, answerKey, materials, snapshot };
}
