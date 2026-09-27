import type { ExamDefinition } from '@ai-measurement/shared';

/** 시험 정의 전체의 자료 key → 제목 */
export function materialTitleMap(definition: ExamDefinition): Map<string, string> {
  return new Map(definition.cases.flatMap((c) => c.materials.map((m) => [m.key, m.title] as const)));
}
