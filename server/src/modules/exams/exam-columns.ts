import { tables } from '@ai-measurement/infra';

/**
 * 수험생·관리자 서버가 읽을 수 있는 시험 컬럼. 루브릭(rubrics)과 정답(answer_keys)은 뺀다.
 * DB 역할 권한(infra/db/migrations/0001_access-roles.sql)과 같은 목록이어야 한다.
 * select()로 전체 컬럼을 읽으면 권한 오류가 나므로 시험 행은 반드시 이 목록으로 읽는다.
 */
export const examSnapshotColumns = {
  id: tables.exams.id,
  slug: tables.exams.slug,
  title: tables.exams.title,
  status: tables.exams.status,
  packageSha256: tables.exams.packageSha256,
  definition: tables.exams.definition,
  grading: tables.exams.grading,
  materialFiles: tables.exams.materialFiles,
  importedBy: tables.exams.importedBy,
  importedAt: tables.exams.importedAt,
  openedAt: tables.exams.openedAt,
  closedAt: tables.exams.closedAt,
};

export type ExamRecord = Omit<typeof tables.exams.$inferSelect, 'rubrics' | 'answerKeys'>;
