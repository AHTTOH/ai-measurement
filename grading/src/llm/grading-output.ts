import { z } from 'zod';
import type { Axis } from '@ai-measurement/shared';

/** LLM 채점 결과 형식. 구조화 출력(output_config.format)으로 이 스키마를 강제한다 */
export const llmGradingOutputSchema = z.strictObject({
  criteria: z.array(
    z.strictObject({
      id: z.string(),
      score: z.number(),
      rationale: z.string(),
      /** 근거 식별자. 예: M12, A:1-3@v2 */
      evidence: z.array(z.string()),
    }),
  ),
  numeric: z.array(
    z.strictObject({
      id: z.string(),
      /** 응시자 최종 답안에 적힌 값. 없으면 null */
      reportedValue: z.number().nullable(),
      quote: z.string(),
    }),
  ),
});

export type LlmGradingOutput = z.infer<typeof llmGradingOutputSchema>;

/** 한 Case에서 LLM에 맡기는 항목 */
export interface LlmItemsSpec {
  criteria: Array<{ id: string; axis: Axis; description: string; points: number }>;
  numeric: Array<{ id: string; subquestion: string; label: string }>;
}

/**
 * 스키마 검증을 통과한 결과가 이 Case의 항목과 정확히 맞는지 본다.
 * 빠진 항목, 모르는 항목, 배점 범위를 벗어난 점수가 있으면 사유를 돌려준다.
 */
export function outputMismatch(output: LlmGradingOutput, items: LlmItemsSpec): string | null {
  const expectedCriteria = new Map(items.criteria.map((c) => [c.id, c.points]));
  const seen = new Set<string>();
  for (const c of output.criteria) {
    const points = expectedCriteria.get(c.id);
    if (points === undefined) return `모르는 기준 id: ${c.id}`;
    if (seen.has(c.id)) return `중복된 기준 id: ${c.id}`;
    seen.add(c.id);
    if (!Number.isFinite(c.score) || c.score < 0 || c.score > points) return `기준 ${c.id} 점수 ${c.score}가 0~${points} 범위를 벗어납니다`;
  }
  if (seen.size !== expectedCriteria.size) return `빠진 기준이 있습니다(${expectedCriteria.size}개 중 ${seen.size}개)`;
  const expectedNumeric = new Set(items.numeric.map((n) => n.id));
  const seenNumeric = new Set(output.numeric.map((n) => n.id));
  if (seenNumeric.size !== output.numeric.length) return '중복된 수치 항목이 있습니다';
  for (const id of seenNumeric) if (!expectedNumeric.has(id)) return `모르는 수치 항목: ${id}`;
  if (seenNumeric.size !== expectedNumeric.size) return '빠진 수치 항목이 있습니다';
  return null;
}

/** 응답 텍스트를 JSON으로 읽고 스키마·항목을 검증한다 */
export function parseGradingText(text: string, items: LlmItemsSpec): { ok: true; output: LlmGradingOutput } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `채점 응답이 JSON이 아닙니다: ${(error as Error).message}` };
  }
  const parsed = llmGradingOutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `채점 응답 형식 오류: ${parsed.error.issues[0]?.message ?? '알 수 없음'}` };
  const mismatch = outputMismatch(parsed.data, items);
  return mismatch === null ? { ok: true, output: parsed.data } : { ok: false, error: mismatch };
}
