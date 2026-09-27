import type {
  AnswerKey,
  Axis,
  CaseDefinition,
  CsvTable,
  ExamDefinition,
  GradingConfig,
  MaterialFacts,
  Rubric,
} from '@ai-measurement/shared';
import type { SessionSnapshot } from '../context/session-snapshot';

export type GraderKind = 'rule' | 'llm' | 'llm-mock';

/** 채점 항목 하나의 결과. earned가 null이면 미채점이다(0점으로 메우지 않는다) */
export interface ItemResult {
  caseKey: string;
  axis: Axis;
  itemId: string;
  itemKind: 'rule' | 'criterion';
  description: string;
  points: number;
  earned: number | null;
  status: 'graded' | 'ungraded';
  grader: GraderKind;
  detail: Record<string, unknown>;
  model: string | null;
}

/** 채점에 쓰는 시험 스냅샷(등록 당시 DB에 저장한 정의) */
export interface GradingExam {
  id: string;
  slug: string;
  definition: ExamDefinition;
  grading: GradingConfig;
  rubrics: Record<string, Rubric>;
  answerKeys: Record<string, AnswerKey>;
}

export interface CaseContext {
  exam: GradingExam;
  caseDef: CaseDefinition;
  rubric: Rubric;
  answerKey: AnswerKey;
  materials: Readonly<Record<string, MaterialFacts>>;
  snapshot: SessionSnapshot;
}

export function csvTableOf(context: CaseContext, materialKey: string): CsvTable {
  const facts = context.materials[materialKey];
  if (facts?.kind !== 'csv') throw new Error(`CSV 자료를 읽지 못했습니다: ${materialKey}`);
  return facts.table;
}
