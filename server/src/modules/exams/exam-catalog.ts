import path from 'node:path';
import { tables, type Database } from '@ai-measurement/infra';
import type { CaseDefinition, MaterialDefinition, SubquestionDefinition } from '@ai-measurement/shared';
import { eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { examSnapshotColumns, type ExamRecord } from './exam-columns';

export type { ExamRecord } from './exam-columns';

/** 매 요청 새로 읽는 가벼운 컬럼. 상태는 다른 프로세스(관리자 서버)가 바꾸므로 캐시하지 않는다 */
const examHeadColumns = {
  status: tables.exams.status,
  openedAt: tables.exams.openedAt,
  closedAt: tables.exams.closedAt,
  packageSha256: tables.exams.packageSha256,
  importedAt: tables.exams.importedAt,
};

/**
 * 등록된 시험 스냅샷을 읽는다. 루브릭·정답 컬럼은 읽지 않는다(exam-columns.ts).
 * 수험생 서버와 관리자 서버가 각자 캐시를 가지므로, 상태(열기·종료)는 매번 DB에서 읽는다.
 * 정의·자료 같은 큰 컬럼은 패키지 버전(해시·등록 시각)이 같을 때만 캐시를 쓰고, 다르면 다시 읽는다(재등록 반영).
 */
export class ExamCatalog {
  private readonly cache = new Map<string, ExamRecord>();

  constructor(
    private readonly db: Database,
    readonly examsDir: string,
  ) {}

  async get(examId: string): Promise<ExamRecord> {
    const [head] = await this.db.select(examHeadColumns).from(tables.exams).where(eq(tables.exams.id, examId)).limit(1);
    if (head === undefined) throw appErrors.notFound('exam_not_found', '시험을 찾을 수 없습니다');
    const cached = this.cache.get(examId);
    if (cached !== undefined && cached.packageSha256 === head.packageSha256 && cached.importedAt.getTime() === head.importedAt.getTime()) {
      return { ...cached, status: head.status, openedAt: head.openedAt, closedAt: head.closedAt };
    }
    const [exam] = await this.db.select(examSnapshotColumns).from(tables.exams).where(eq(tables.exams.id, examId)).limit(1);
    if (exam === undefined) throw appErrors.notFound('exam_not_found', '시험을 찾을 수 없습니다');
    this.cache.set(examId, exam);
    return exam;
  }

  packageDir(exam: ExamRecord): string {
    return path.join(this.examsDir, exam.slug);
  }

  findCase(exam: ExamRecord, caseKey: string): CaseDefinition {
    const caseDef = exam.definition.cases.find((c) => c.key === caseKey);
    if (caseDef === undefined) throw appErrors.notFound('case_not_found', 'Case를 찾을 수 없습니다');
    return caseDef;
  }

  findSubquestion(exam: ExamRecord, subquestionKey: string): { caseDef: CaseDefinition; subquestion: SubquestionDefinition } {
    for (const caseDef of exam.definition.cases) {
      const subquestion = caseDef.subquestions.find((s) => s.key === subquestionKey);
      if (subquestion !== undefined) return { caseDef, subquestion };
    }
    throw appErrors.notFound('subquestion_not_found', '하위문항을 찾을 수 없습니다');
  }

  findMaterial(exam: ExamRecord, caseKey: string, materialKey: string): MaterialDefinition {
    const material = this.findCase(exam, caseKey).materials.find((m) => m.key === materialKey);
    if (material === undefined) throw appErrors.notFound('material_not_found', '이 Case의 자료가 아닙니다');
    return material;
  }
}
