import { z } from 'zod';
import { AXES } from '../axes';
import { keySchema, nonEmptyText } from './common-schema';

/**
 * 시험 패키지 exam.json 스키마 v1.
 * 응시자에게 보이는 시험 정의와 응시용 AI 설정을 담는다. 채점 정보는 grading.json·rubrics·answer-keys에 따로 둔다.
 * 모든 값은 필수다. 코드 쪽 기본값으로 채우지 않는다(폴백 금지).
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const aiSettingsSchema = z.strictObject({
  model: nonEmptyText,
  effort: z.enum(EFFORT_LEVELS),
  maxTokens: z.number().int().min(1).max(128_000),
  systemPrompt: nonEmptyText,
});

export const answerFormatSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text') }),
  z.strictObject({
    kind: z.literal('multi_choice'),
    options: z.array(z.strictObject({ id: keySchema, label: nonEmptyText })).min(2),
    /** 선택과 함께 적는 자유 기술 칸(예: 비고). 없으면 칸을 두지 않는다(2026-09-27 신영환 요청) */
    note: z.strictObject({ label: nonEmptyText }).optional(),
  }),
]);

export const SUBQUESTION_TYPES = ['review', 'select_data', 'ai_task', 'verify', 'final'] as const;

export const subquestionSchema = z.strictObject({
  key: keySchema,
  title: nonEmptyText,
  type: z.enum(SUBQUESTION_TYPES),
  prompt: nonEmptyText,
  answer: answerFormatSchema,
  /** 문항 아래에 보이는 유의사항. 한 페이지로 이어지는 응시 화면에서 문항 사이에 놓인다(2026-09-27) */
  guidance: z.array(nonEmptyText).optional(),
  /** 이 공지가 열려야 보이는 하위문항이면 공지 key, 처음부터 보이면 null */
  unlockedByNotice: keySchema.nullable(),
});

export const revealConditionSchema = z.discriminatedUnion('after', [
  z.strictObject({ after: z.literal('subquestion_submitted'), subquestion: keySchema }),
  z.strictObject({ after: z.literal('elapsed_minutes'), minutes: z.number().int().min(1) }),
]);

export const noticeSchema = z.strictObject({
  key: keySchema,
  /** 공지를 보낸 주체. 예: 개인정보보호 담당자 */
  from: nonEmptyText,
  title: nonEmptyText,
  body: nonEmptyText,
  reveal: revealConditionSchema,
});

export const MATERIAL_KINDS = ['csv', 'pdf'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** 자료 파일 경로는 materials/ 바로 아래 파일만 허용한다(경로 조작 방지). */
export const MATERIAL_FILE_PATTERN = /^materials\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const materialSchema = z.strictObject({
  key: keySchema,
  title: nonEmptyText,
  kind: z.enum(MATERIAL_KINDS),
  file: z.string().regex(MATERIAL_FILE_PATTERN, 'materials/ 바로 아래 파일 이름이어야 합니다'),
});

export const caseSchema = z.strictObject({
  key: keySchema,
  title: nonEmptyText,
  brief: nonEmptyText,
  materials: z.array(materialSchema),
  subquestions: z.array(subquestionSchema).min(1),
  notices: z.array(noticeSchema),
});

export const VIOLATION_POLICIES = ['flag_only', 'review', 'fail'] as const;
export type ViolationPolicy = (typeof VIOLATION_POLICIES)[number];

const axisWeightsShape = Object.fromEntries(AXES.map((axis) => [axis, z.number().int().min(0).max(100)])) as Record<
  (typeof AXES)[number],
  z.ZodNumber
>;

export const examDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    slug: keySchema,
    title: nonEmptyText,
    /** PRD 5장의 응시자 안내문 */
    candidateNotice: nonEmptyText,
    durationMinutes: z.number().int().min(1).max(600),
    tokenBudget: z.number().int().min(1),
    contextTokenLimit: z.number().int().min(1),
    ai: aiSettingsSchema,
    axisWeights: z.strictObject(axisWeightsShape),
    violationPolicy: z.enum(VIOLATION_POLICIES),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const sum = AXES.reduce((acc, axis) => acc + value.axisWeights[axis], 0);
    if (sum !== 100) {
      ctx.addIssue({ code: 'custom', path: ['axisWeights'], message: `세 축 가중치 합은 100이어야 합니다(현재 ${sum})` });
    }
  });

export type AiSettings = z.infer<typeof aiSettingsSchema>;
export type AnswerFormat = z.infer<typeof answerFormatSchema>;
export type SubquestionDefinition = z.infer<typeof subquestionSchema>;
export type RevealCondition = z.infer<typeof revealConditionSchema>;
export type NoticeDefinition = z.infer<typeof noticeSchema>;
export type MaterialDefinition = z.infer<typeof materialSchema>;
export type CaseDefinition = z.infer<typeof caseSchema>;
export type ExamDefinition = z.infer<typeof examDefinitionSchema>;
