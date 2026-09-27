import { z } from 'zod';
import { AXES } from '../axes';
import { EFFORT_LEVELS } from './exam-definition-schema';
import { keySchema, nonEmptyText, positivePoints } from './common-schema';

/**
 * 채점 전용 파일 스키마 v1: grading.json, rubrics/<caseKey>.json, answer-keys/<caseKey>.json.
 * 이 파일들의 내용은 응시자에게 어떤 경로로도 노출하지 않는다.
 */

function isCompilableRegex(source: string): boolean {
  try {
    new RegExp(source, 'gu');
    return true;
  } catch {
    return false;
  }
}

export const detectionPatternSchema = z.strictObject({
  id: keySchema,
  label: nonEmptyText,
  regex: nonEmptyText.refine(isCompilableRegex, '정규식으로 해석할 수 없습니다'),
  /** true면 적중 시 중대 보안 위반으로 기록한다(PRD 9장) */
  severe: z.boolean(),
});

export const tagPolicySchema = z.strictObject({
  label: nonEmptyText,
  severe: z.boolean(),
});

export const graderSettingsSchema = z.strictObject({
  model: nonEmptyText,
  effort: z.enum(EFFORT_LEVELS),
  maxTokens: z.number().int().min(1).max(128_000),
});

export const gradingConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rubricVersion: nonEmptyText,
  grader: graderSettingsSchema,
  tags: z.record(keySchema, tagPolicySchema),
  patterns: z.array(detectionPatternSchema),
});

/* ---------- answer-keys/<caseKey>.json ---------- */

export const cellValuesFingerprintSchema = z.strictObject({
  type: z.literal('cell_values'),
  /**
   * 이 길이 미만의 셀 값은 지문으로 쓰지 않는다(짧은 값의 우연 일치 방지).
   * 유출 판정용 컬럼은 충분히 길게(예: 전화번호 8), 필요 컬럼 전달 판정용은 짧게 둘 수 있다.
   */
  minLength: z.number().int().min(1),
});

export const textFingerprintSchema = z.strictObject({
  type: z.literal('text'),
  texts: z.array(nonEmptyText).min(1),
});

export const csvColumnKeySchema = z.strictObject({
  label: nonEmptyText,
  tags: z.array(keySchema).min(1),
  fingerprint: cellValuesFingerprintSchema,
});

export const csvRowKeySchema = z.strictObject({
  id: keySchema,
  label: nonEmptyText,
  /** 행을 찾는 방법: 이 컬럼 값이 이 값인 행 하나 */
  match: z.strictObject({ column: nonEmptyText, value: nonEmptyText }),
  tags: z.array(keySchema).min(1),
  fingerprint: textFingerprintSchema,
});

export const pdfPageKeySchema = z.strictObject({
  id: keySchema,
  label: nonEmptyText,
  page: z.number().int().min(1),
  tags: z.array(keySchema).min(1),
  fingerprint: textFingerprintSchema,
});

export const materialAnswerKeySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('csv'),
    columns: z.record(nonEmptyText, csvColumnKeySchema),
    rows: z.array(csvRowKeySchema),
  }),
  z.strictObject({
    kind: z.literal('pdf'),
    pages: z.array(pdfPageKeySchema),
  }),
]);

export const answerKeySchema = z.strictObject({
  caseKey: keySchema,
  materials: z.record(keySchema, materialAnswerKeySchema),
  /** 선택형 하위문항의 정답 선택지 */
  choiceAnswers: z.record(keySchema, z.array(keySchema).min(1)),
  /** 서술형 하위문항의 기준답안(마크다운) */
  referenceAnswers: z.record(keySchema, nonEmptyText),
});

/* ---------- rubrics/<caseKey>.json ---------- */

const ruleBase = {
  id: keySchema,
  description: nonEmptyText,
  points: positivePoints,
};

export const ruleSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...ruleBase,
    type: z.literal('choice_answer'),
    subquestion: keySchema,
    scoring: z.enum(['all_or_nothing', 'per_option']),
  }),
  z.strictObject({
    ...ruleBase,
    type: z.literal('columns_sent'),
    material: keySchema,
    columns: z.array(nonEmptyText).min(1),
    /** 붙여넣기로 보낸 경우, 헤더와 함께 이 개수 이상의 서로 다른 값이 보여야 보낸 것으로 본다 */
    minDistinctValues: z.number().int().min(1),
  }),
  z.strictObject({
    ...ruleBase,
    type: z.literal('columns_withheld'),
    material: keySchema,
    columns: z.array(nonEmptyText).min(1),
  }),
  z.strictObject({
    ...ruleBase,
    type: z.literal('rows_withheld'),
    material: keySchema,
    rows: z.array(keySchema).min(1),
  }),
  z.strictObject({
    ...ruleBase,
    type: z.literal('pages_withheld'),
    material: keySchema,
    pages: z.array(keySchema).min(1),
  }),
  z.strictObject({
    ...ruleBase,
    type: z.literal('patterns_absent'),
    patterns: z.array(keySchema).min(1),
  }),
  z.strictObject({
    ...ruleBase,
    type: z.literal('answer_revised_after_notice'),
    notice: keySchema,
    subquestion: keySchema,
    /**
     * 공지 전에 답안이 없었고 공지 뒤에 처음 쓴 경우를 수정으로 볼지.
     * false면 공지 전 답안이 있어야 하고, 공지 뒤 다른 내용으로 다시 저장·제출해야 점수를 준다
     */
    firstAnswerAfterNoticeCounts: z.boolean(),
  }),
  z.strictObject({
    ...ruleBase,
    type: z.literal('numeric_value'),
    subquestion: keySchema,
    /** 채점 LLM이 답안에서 찾을 수치의 이름. 예: 부서별 평균 근속연수(영업1팀) */
    label: nonEmptyText,
    expected: z.number(),
    tolerance: z.number().min(0),
  }),
]);

export const criterionSchema = z.strictObject({
  id: keySchema,
  description: nonEmptyText,
  points: positivePoints,
});

export const axisRubricSchema = z
  .strictObject({
    max: positivePoints,
    rules: z.array(ruleSchema),
    criteria: z.array(criterionSchema),
  })
  .superRefine((value, ctx) => {
    const sum = [...value.rules, ...value.criteria].reduce((acc, item) => acc + item.points, 0);
    if (Math.abs(sum - value.max) > 1e-9) {
      ctx.addIssue({ code: 'custom', path: ['max'], message: `규칙·기준 배점 합(${sum})이 max(${value.max})와 같아야 합니다` });
    }
  });

const axesShape = Object.fromEntries(AXES.map((axis) => [axis, axisRubricSchema])) as Record<
  (typeof AXES)[number],
  typeof axisRubricSchema
>;

export const rubricSchema = z.strictObject({
  caseKey: keySchema,
  axes: z.strictObject(axesShape),
});

export type DetectionPattern = z.infer<typeof detectionPatternSchema>;
export type TagPolicy = z.infer<typeof tagPolicySchema>;
export type GraderSettings = z.infer<typeof graderSettingsSchema>;
export type GradingConfig = z.infer<typeof gradingConfigSchema>;
export type CsvColumnKey = z.infer<typeof csvColumnKeySchema>;
export type CsvRowKey = z.infer<typeof csvRowKeySchema>;
export type PdfPageKey = z.infer<typeof pdfPageKeySchema>;
export type MaterialAnswerKey = z.infer<typeof materialAnswerKeySchema>;
export type AnswerKey = z.infer<typeof answerKeySchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type RuleType = Rule['type'];
export type Criterion = z.infer<typeof criterionSchema>;
export type AxisRubric = z.infer<typeof axisRubricSchema>;
export type Rubric = z.infer<typeof rubricSchema>;
