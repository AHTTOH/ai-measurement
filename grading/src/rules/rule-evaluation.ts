import { answerContentsEqual, computeNoticeRevealTimes, findPatternHits, type Axis, type Rule } from '@ai-measurement/shared';
import { finalAnswer } from '../context/session-snapshot';
import { csvTableOf, type CaseContext, type ItemResult } from './item-result';
import { columnOccurrences, columnSentMessages, pageOccurrences, rowOccurrences, type LeakOccurrence } from './leak-detection';

/** LLM이 답안에서 값을 뽑아야 끝나는 규칙(numeric_value) */
export type DeterministicRule = Exclude<Rule, { type: 'numeric_value' }>;

function result(context: CaseContext, axis: Axis, rule: Rule, earned: number, detail: Record<string, unknown>): ItemResult {
  return {
    caseKey: context.caseDef.key,
    axis,
    itemId: rule.id,
    itemKind: 'rule',
    description: rule.description,
    points: rule.points,
    earned,
    status: 'graded',
    grader: 'rule',
    detail: { type: rule.type, ...detail },
    model: null,
  };
}

function csvKey(context: CaseContext, materialKey: string) {
  const key = context.answerKey.materials[materialKey];
  if (key?.kind !== 'csv') throw new Error(`정답 메타에 CSV 자료가 없습니다: ${materialKey}`);
  return key;
}

function evaluateChoice(context: CaseContext, rule: Extract<Rule, { type: 'choice_answer' }>) {
  const answer = finalAnswer(context.snapshot, rule.subquestion);
  const correctIds = context.answerKey.choiceAnswers[rule.subquestion];
  if (correctIds === undefined) throw new Error(`정답 메타에 선택형 정답이 없습니다: ${rule.subquestion}`);
  const correct = new Set(correctIds);
  if (answer === null || answer.content.kind !== 'multi_choice') return { earned: 0, detail: { reason: 'no_final_answer', correct: [...correct] } };
  const selected = answer.content.selected;
  const right = selected.filter((id) => correct.has(id)).length;
  const wrong = selected.length - right;
  const earned =
    rule.scoring === 'all_or_nothing'
      ? right === correct.size && wrong === 0
        ? rule.points
        : 0
      : (rule.points * Math.max(0, right - wrong)) / correct.size;
  return { earned, detail: { selected, correct: [...correct], right, wrong, answerVersion: answer.version } };
}

function withheld(occurrencesByTarget: Record<string, LeakOccurrence[]>, points: number) {
  const leaked = Object.values(occurrencesByTarget).some((list) => list.length > 0);
  return { earned: leaked ? 0 : points, detail: { leaks: occurrencesByTarget } };
}

function evaluateRevision(context: CaseContext, rule: Extract<Rule, { type: 'answer_revised_after_notice' }>) {
  const { snapshot, caseDef } = context;
  const revealAt = computeNoticeRevealTimes(caseDef, {
    sessionStartedAt: snapshot.startedAt,
    firstFinalSubmissionAt: snapshot.firstSubmissionAt,
    now: snapshot.endedAt,
  }).get(rule.notice);
  if (revealAt === undefined) return { earned: 0, detail: { reason: 'notice_not_revealed' } };
  const versions = snapshot.answers.filter((a) => a.subquestionKey === rule.subquestion && a.source !== 'auto_final_on_end');
  const before = versions.filter((v) => v.savedAt.getTime() <= revealAt.getTime()).at(-1);
  const after = versions.filter((v) => v.savedAt.getTime() > revealAt.getTime());
  if (before === undefined && !rule.firstAnswerAfterNoticeCounts) {
    return { earned: 0, detail: { reason: 'no_answer_before_notice', revealedAt: revealAt.toISOString(), versionsAfter: after.map((v) => v.version) } };
  }
  const revised = after.some((v) => before === undefined || !answerContentsEqual(v.content, before.content));
  return {
    earned: revised ? rule.points : 0,
    detail: { revealedAt: revealAt.toISOString(), versionBefore: before?.version ?? null, versionsAfter: after.map((v) => v.version), revised },
  };
}

/** 결정적 규칙 하나를 판정한다. 같은 입력이면 언제나 같은 결과다 */
export function evaluateDeterministicRule(context: CaseContext, axis: Axis, rule: DeterministicRule): ItemResult {
  const messages = context.snapshot.messages;
  switch (rule.type) {
    case 'choice_answer': {
      const { earned, detail } = evaluateChoice(context, rule);
      return result(context, axis, rule, earned, detail);
    }
    case 'columns_sent': {
      const table = csvTableOf(context, rule.material);
      const key = csvKey(context, rule.material);
      const sentIn = Object.fromEntries(
        rule.columns.map((column) => {
          const columnKey = key.columns[column];
          if (columnKey === undefined) throw new Error(`정답 메타에 컬럼이 없습니다: ${column}`);
          return [column, columnSentMessages(table, column, columnKey, rule.minDistinctValues, messages)];
        }),
      );
      const allSent = Object.values(sentIn).every((ids) => ids.length > 0);
      return result(context, axis, rule, allSent ? rule.points : 0, { sentIn });
    }
    case 'columns_withheld': {
      const table = csvTableOf(context, rule.material);
      const key = csvKey(context, rule.material);
      const occurrences = Object.fromEntries(
        rule.columns.map((column) => {
          const columnKey = key.columns[column];
          if (columnKey === undefined) throw new Error(`정답 메타에 컬럼이 없습니다: ${column}`);
          return [column, columnOccurrences(table, column, columnKey, messages)];
        }),
      );
      const { earned, detail } = withheld(occurrences, rule.points);
      return result(context, axis, rule, earned, detail);
    }
    case 'rows_withheld': {
      const key = csvKey(context, rule.material);
      const occurrences = Object.fromEntries(
        rule.rows.map((rowId) => {
          const rowKey = key.rows.find((r) => r.id === rowId);
          if (rowKey === undefined) throw new Error(`정답 메타에 행이 없습니다: ${rowId}`);
          return [rowId, rowOccurrences(rowKey, messages)];
        }),
      );
      const { earned, detail } = withheld(occurrences, rule.points);
      return result(context, axis, rule, earned, detail);
    }
    case 'pages_withheld': {
      const key = context.answerKey.materials[rule.material];
      if (key?.kind !== 'pdf') throw new Error(`정답 메타에 PDF 자료가 없습니다: ${rule.material}`);
      const occurrences = Object.fromEntries(
        rule.pages.map((pageId) => {
          const pageKey = key.pages.find((p) => p.id === pageId);
          if (pageKey === undefined) throw new Error(`정답 메타에 페이지가 없습니다: ${pageId}`);
          return [pageId, pageOccurrences(rule.material, pageKey, messages)];
        }),
      );
      const { earned, detail } = withheld(occurrences, rule.points);
      return result(context, axis, rule, earned, detail);
    }
    case 'patterns_absent': {
      const patterns = context.exam.grading.patterns.filter((p) => rule.patterns.includes(p.id));
      const hits = messages
        .filter((m) => m.role === 'user' && m.caseKey === context.caseDef.key)
        .flatMap((m) => findPatternHits(m.sentText, patterns).map((h) => ({ messageId: m.id, ...h })));
      return result(context, axis, rule, hits.length === 0 ? rule.points : 0, { hits });
    }
    case 'answer_revised_after_notice': {
      const { earned, detail } = evaluateRevision(context, rule);
      return result(context, axis, rule, earned, detail);
    }
  }
}
