import { tables, type Database } from '@ai-measurement/infra';
import type { SessionScoreView } from '@ai-measurement/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';

/** 시험의 가장 최근 완료 채점 작업 id. 없으면 null */
export async function latestDoneJobId(db: Database, examId: string): Promise<string | null> {
  const [job] = await db
    .select({ id: tables.gradingJobs.id })
    .from(tables.gradingJobs)
    .where(and(eq(tables.gradingJobs.examId, examId), eq(tables.gradingJobs.status, 'done')))
    .orderBy(desc(tables.gradingJobs.finishedAt))
    .limit(1);
  return job?.id ?? null;
}

/** 채점 작업 하나의 세션별 점수와 사용된 채점 방식 */
export async function scoresForJob(db: Database, jobId: string, sessionIds: readonly string[]): Promise<Map<string, SessionScoreView>> {
  if (sessionIds.length === 0) return new Map();
  const scores = await db
    .select()
    .from(tables.sessionScores)
    .where(and(eq(tables.sessionScores.gradingJobId, jobId), inArray(tables.sessionScores.examSessionId, [...sessionIds])));
  const graders = await db
    .selectDistinct({ sessionId: tables.gradeItems.examSessionId, grader: tables.gradeItems.grader })
    .from(tables.gradeItems)
    .where(and(eq(tables.gradeItems.gradingJobId, jobId), inArray(tables.gradeItems.examSessionId, [...sessionIds])));
  const gradersBySession = new Map<string, string[]>();
  for (const g of graders) gradersBySession.set(g.sessionId, [...(gradersBySession.get(g.sessionId) ?? []), g.grader]);
  return new Map(
    scores.map((s) => [
      s.examSessionId,
      {
        gradingJobId: jobId,
        status: s.status,
        total: s.total,
        axisPercent: s.axisPercent,
        violationCount: s.violationCount,
        outcome: s.outcome,
        graderKinds: (gradersBySession.get(s.examSessionId) ?? []).sort(),
      },
    ]),
  );
}
