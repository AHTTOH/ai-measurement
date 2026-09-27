import { AXES, type Rule } from '@ai-measurement/shared';
import type { CaseContext, GraderKind, ItemResult } from '../rules/item-result';
import type { LlmItemsSpec } from './grading-output';
import type { LlmGradingResult } from './llm-grader';

type NumericRule = Extract<Rule, { type: 'numeric_value' }>;

function numericRules(context: CaseContext): Array<{ axis: (typeof AXES)[number]; rule: NumericRule }> {
  return AXES.flatMap((axis) =>
    context.rubric.axes[axis].rules.flatMap((rule) => (rule.type === 'numeric_value' ? [{ axis, rule }] : [])),
  );
}

/**
 * LLM 결과를 항목 점수로 바꾼다. 결과가 실패면 해당 항목을 모두 미채점(earned=null)으로 둔다.
 * 수치 항목은 LLM이 답안에서 옮겨 적은 값을 코드가 기준값·허용오차와 비교한다.
 */
export function llmItemResults(
  context: CaseContext,
  items: LlmItemsSpec,
  result: LlmGradingResult,
  graderKind: GraderKind,
  messageRefs: ReadonlyMap<string, string>,
): ItemResult[] {
  const caseKey = context.caseDef.key;
  const criteria = items.criteria.map((criterion): ItemResult => {
    const base = { caseKey, axis: criterion.axis, itemId: criterion.id, itemKind: 'criterion' as const, description: criterion.description, points: criterion.points, grader: graderKind };
    if (!result.ok) return { ...base, earned: null, status: 'ungraded', detail: { error: result.error }, model: null };
    const scored = result.output.criteria.find((c) => c.id === criterion.id);
    if (scored === undefined) return { ...base, earned: null, status: 'ungraded', detail: { error: '결과에 이 기준이 없습니다' }, model: result.model };
    const evidenceMessageIds = scored.evidence.flatMap((ref) => {
      const id = messageRefs.get(ref);
      return id !== undefined ? [id] : [];
    });
    return {
      ...base,
      earned: scored.score,
      status: 'graded',
      detail: { rationale: scored.rationale, evidence: scored.evidence, evidenceMessageIds },
      model: result.model,
    };
  });

  const numeric = numericRules(context).map(({ axis, rule }): ItemResult => {
    const base = { caseKey, axis, itemId: rule.id, itemKind: 'rule' as const, description: rule.description, points: rule.points, grader: graderKind };
    if (!result.ok) return { ...base, earned: null, status: 'ungraded', detail: { type: rule.type, error: result.error }, model: null };
    const extracted = result.output.numeric.find((n) => n.id === rule.id);
    if (extracted === undefined) return { ...base, earned: null, status: 'ungraded', detail: { type: rule.type, error: '결과에 이 수치 항목이 없습니다' }, model: result.model };
    const withinTolerance = extracted.reportedValue !== null && Math.abs(extracted.reportedValue - rule.expected) <= rule.tolerance;
    return {
      ...base,
      earned: withinTolerance ? rule.points : 0,
      status: 'graded',
      detail: { type: rule.type, expected: rule.expected, tolerance: rule.tolerance, reportedValue: extracted.reportedValue, quote: extracted.quote },
      model: result.model,
    };
  });

  return [...criteria, ...numeric];
}
