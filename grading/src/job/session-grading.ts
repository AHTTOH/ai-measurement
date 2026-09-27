import { AXES, type MaterialFacts } from '@ai-measurement/shared';
import { findSevereViolations, type ViolationRecord } from '../aggregate/severe-violations';
import type { SessionSnapshot } from '../context/session-snapshot';
import type { LlmItemsSpec } from '../llm/grading-output';
import { buildCandidateBlock, buildCaseBlock, GRADER_SYSTEM_PROMPT, llmItemsOf } from '../llm/grading-prompt';
import type { LlmGradingRequest, LlmGradingResult } from '../llm/llm-grader';
import { llmItemResults } from '../llm/llm-item-results';
import type { CaseContext, GraderKind, GradingExam, ItemResult } from '../rules/item-result';
import { evaluateDeterministicRule } from '../rules/rule-evaluation';

export interface PreparedCase {
  context: CaseContext;
  ruleItems: ItemResult[];
  /** LLM에 맡길 항목이 없으면 null */
  llm: { items: LlmItemsSpec; caseBlock: string; candidateBlock: string; messageRefs: Map<string, string> } | null;
}

export interface PreparedSession {
  snapshot: SessionSnapshot;
  cases: PreparedCase[];
  violations: ViolationRecord[];
}

/** 세션 하나의 결정적 규칙을 판정하고 LLM 요청 재료를 만든다 */
export function prepareSession(exam: GradingExam, materials: Readonly<Record<string, MaterialFacts>>, snapshot: SessionSnapshot): PreparedSession {
  const cases = exam.definition.cases.map((caseDef): PreparedCase => {
    const rubric = exam.rubrics[caseDef.key];
    const answerKey = exam.answerKeys[caseDef.key];
    if (rubric === undefined || answerKey === undefined) throw new Error(`Case '${caseDef.key}'의 루브릭 또는 정답 메타가 없습니다`);
    const context: CaseContext = { exam, caseDef, rubric, answerKey, materials, snapshot };
    const ruleItems = AXES.flatMap((axis) =>
      rubric.axes[axis].rules.flatMap((rule) => (rule.type === 'numeric_value' ? [] : [evaluateDeterministicRule(context, axis, rule)])),
    );
    const items = llmItemsOf(rubric);
    const needsLlm = items.criteria.length > 0 || items.numeric.length > 0;
    if (!needsLlm) return { context, ruleItems, llm: null };
    const candidate = buildCandidateBlock(caseDef, snapshot);
    return {
      context,
      ruleItems,
      llm: { items, caseBlock: buildCaseBlock(caseDef, answerKey, items), candidateBlock: candidate.text, messageRefs: candidate.messageRefs },
    };
  });
  return { snapshot, cases, violations: findSevereViolations(exam, materials, snapshot) };
}

export function llmRequestOf(exam: GradingExam, prepared: PreparedCase, customId: string): LlmGradingRequest {
  if (prepared.llm === null) throw new Error('LLM 항목이 없는 Case입니다');
  return {
    customId,
    system: GRADER_SYSTEM_PROMPT,
    caseBlock: prepared.llm.caseBlock,
    candidateBlock: prepared.llm.candidateBlock,
    settings: exam.grading.grader,
    items: prepared.llm.items,
  };
}

/** 규칙 결과와 LLM 결과를 합쳐 세션의 전체 항목 결과를 만든다 */
export function completeSession(
  prepared: PreparedSession,
  resultFor: (caseKey: string) => LlmGradingResult | undefined,
  graderKind: GraderKind,
): ItemResult[] {
  return prepared.cases.flatMap((c) => {
    if (c.llm === null) return c.ruleItems;
    const result = resultFor(c.context.caseDef.key) ?? { customId: '', ok: false as const, error: 'LLM 채점 결과를 받지 못했습니다' };
    return [...c.ruleItems, ...llmItemResults(c.context, c.llm.items, result, graderKind, c.llm.messageRefs)];
  });
}
