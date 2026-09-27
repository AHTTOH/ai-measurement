import { tables, type Database } from '@ai-measurement/infra';
import type { AiProviderName, GradingJobView } from '@ai-measurement/shared';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { actorOf, writeAudit } from '../audit/audit-log';

type GradingJobRecord = typeof tables.gradingJobs.$inferSelect;

export function gradingJobView(job: GradingJobRecord): GradingJobView {
  return {
    id: job.id,
    status: job.status,
    llmMode: job.llmMode,
    llmProvider: job.llmProvider,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: job.error,
    progress: job.progress,
  };
}

/** 채점 작업 등록(결정 D10). 실제 채점은 grading 워커가 큐에서 꺼내 처리한다 */
export class GradingJobService {
  constructor(
    private readonly db: Database,
    private readonly llmProvider: AiProviderName,
  ) {}

  async create(examId: string, llmMode: 'direct' | 'batch', adminId: string): Promise<GradingJobView> {
    return this.db.transaction(async (tx) => {
      const [exam] = await tx.select({ id: tables.exams.id }).from(tables.exams).where(eq(tables.exams.id, examId)).for('update').limit(1);
      if (exam === undefined) throw appErrors.notFound('exam_not_found', '시험을 찾을 수 없습니다');
      const [finished] = await tx
        .select({ n: count() })
        .from(tables.examSessions)
        .where(and(eq(tables.examSessions.examId, examId), ne(tables.examSessions.status, 'active')));
      if ((finished?.n ?? 0) === 0) throw appErrors.conflict('no_finished_sessions', '제출·종료된 응시 세션이 없어 채점할 대상이 없습니다');
      const [running] = await tx
        .select({ id: tables.gradingJobs.id })
        .from(tables.gradingJobs)
        .where(and(eq(tables.gradingJobs.examId, examId), inArray(tables.gradingJobs.status, ['queued', 'running', 'waiting_batch'])))
        .limit(1);
      if (running !== undefined) throw appErrors.conflict('grading_in_progress', '이 시험의 채점 작업이 이미 진행 중입니다');
      const [job] = await tx
        .insert(tables.gradingJobs)
        .values({ examId, status: 'queued', llmMode, llmProvider: this.llmProvider, requestedBy: adminId })
        .returning();
      if (job === undefined) throw new Error('채점 작업을 만들지 못했습니다');
      await writeAudit(tx, { examId, examSessionId: null, actor: actorOf.admin(adminId), kind: 'grading_job_created', payload: { jobId: job.id, llmMode, llmProvider: this.llmProvider } });
      return gradingJobView(job);
    });
  }

  async list(examId: string): Promise<GradingJobView[]> {
    const jobs = await this.db.select().from(tables.gradingJobs).where(eq(tables.gradingJobs.examId, examId)).orderBy(desc(tables.gradingJobs.createdAt));
    return jobs.map(gradingJobView);
  }
}
