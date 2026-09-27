import path from 'node:path';
import { tables, type Database, type Logger } from '@ai-measurement/infra';
import type { MaterialFacts } from '@ai-measurement/shared';
import { parseCsvText, readVerifiedMaterial } from '@ai-measurement/shared/node';
import { and, asc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { scoreSession } from '../aggregate/session-scoring';
import { loadSessionSnapshot } from '../context/session-snapshot';
import { mapWithConcurrency, type LlmGrader, type LlmGradingRequest, type LlmGradingResult } from '../llm/llm-grader';
import type { GradingExam } from '../rules/item-result';
import { completeSession, llmRequestOf, prepareSession, type PreparedSession } from './session-grading';

type GradingJobRecord = typeof tables.gradingJobs.$inferSelect;

export interface GradingJobRunnerOptions {
  db: Database;
  examsDir: string;
  grader: LlmGrader;
  logger: Logger;
  now: () => Date;
  directConcurrency: number;
  /** 작업을 잡은 워커가 이 시간 안에 끝내지 못하면 다른 워커가 다시 잡는다 */
  jobLockMinutes: number;
  /** 배치 결과를 다시 확인하는 간격 */
  batchPollSeconds: number;
}

interface PreparedJob {
  exam: GradingExam;
  sessions: PreparedSession[];
  skippedActive: number;
}

/**
 * 채점 작업 처리(결정 D10): 큐에서 작업을 잡아 종료된 세션을 모두 채점한다.
 * 규칙 판정은 결정적이라 배치 결과를 기다린 뒤 다시 계산해도 같다. 결과는 세션마다 트랜잭션으로 교체 저장한다.
 */
export class GradingJobRunner {
  constructor(private readonly options: GradingJobRunnerOptions) {}

  /** 처리할 작업이 있으면 하나 처리하고 true, 없으면 false */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (job === null) return false;
    try {
      if (job.llmProvider !== this.options.grader.provider) {
        throw new Error(`작업의 채점 공급자(${job.llmProvider})와 워커 설정(${this.options.grader.provider})이 다릅니다`);
      }
      if (job.batchId !== null) await this.collectBatch(job, job.batchId);
      else await this.start(job);
    } catch (error) {
      this.options.logger.error('grading_job_failed', { jobId: job.id, error });
      await this.options.db
        .update(tables.gradingJobs)
        .set({ status: 'failed', finishedAt: this.options.now(), lockedUntil: null, error: error instanceof Error ? error.message : String(error) })
        .where(eq(tables.gradingJobs.id, job.id));
    }
    return true;
  }

  private async claim(): Promise<GradingJobRecord | null> {
    const now = this.options.now();
    return this.options.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(tables.gradingJobs)
        .where(
          or(
            eq(tables.gradingJobs.status, 'queued'),
            and(inArray(tables.gradingJobs.status, ['running', 'waiting_batch']), or(isNull(tables.gradingJobs.lockedUntil), lt(tables.gradingJobs.lockedUntil, now))),
          ),
        )
        .orderBy(asc(tables.gradingJobs.createdAt))
        .for('update', { skipLocked: true })
        .limit(1);
      if (job === undefined) return null;
      const lockedUntil = new Date(now.getTime() + this.options.jobLockMinutes * 60_000);
      const [claimed] = await tx
        .update(tables.gradingJobs)
        .set({ status: job.status === 'queued' ? 'running' : job.status, startedAt: job.startedAt ?? now, lockedUntil })
        .where(eq(tables.gradingJobs.id, job.id))
        .returning();
      return claimed ?? null;
    });
  }

  private async start(job: GradingJobRecord): Promise<void> {
    const prepared = await this.prepare(job);
    if (job.llmMode === 'batch') {
      const { requests, requestMap } = this.buildRequests(prepared);
      if (requests.length === 0) {
        await this.finalize(job, prepared, requestMap, []);
        return;
      }
      const batchId = await this.options.grader.submitBatch(requests);
      await this.options.db
        .update(tables.gradingJobs)
        .set({ status: 'waiting_batch', batchId, batchRequests: requestMap, lockedUntil: this.nextPoll(), progress: this.progress(prepared, 0) })
        .where(eq(tables.gradingJobs.id, job.id));
      this.options.logger.info('grading_batch_submitted', { jobId: job.id, batchId, requests: requests.length });
      return;
    }
    await this.gradeDirect(job, prepared);
  }

  /**
   * 즉시 모드: 세션 단위로 LLM 채점과 저장을 끝낸다. 워커가 중간에 멈춰 작업을 다시 잡아도
   * 이미 점수를 저장한 세션은 건너뛰어 LLM 호출을 되풀이하지 않는다.
   */
  private async gradeDirect(job: GradingJobRecord, prepared: PreparedJob): Promise<void> {
    const finished = await this.options.db
      .select({ sessionId: tables.sessionScores.examSessionId })
      .from(tables.sessionScores)
      .where(eq(tables.sessionScores.gradingJobId, job.id));
    const done = new Set(finished.map((f) => f.sessionId));
    let graded = done.size;
    let failedRequests = 0;
    const pending = prepared.sessions.filter((s) => !done.has(s.snapshot.sessionId));
    await mapWithConcurrency(pending, this.options.directConcurrency, async (session) => {
      const { requests, requestMap } = this.buildRequests({ ...prepared, sessions: [session] });
      const results = await this.options.grader.gradeNow(requests, 1);
      failedRequests += results.filter((r) => !r.ok).length;
      await this.saveSession(job, prepared.exam, session, this.resultsByTarget(requestMap, results));
      graded += 1;
      await this.options.db.update(tables.gradingJobs).set({ progress: this.progress(prepared, graded) }).where(eq(tables.gradingJobs.id, job.id));
    });
    await this.markDone(job, prepared, graded, failedRequests);
  }

  private async collectBatch(job: GradingJobRecord, batchId: string): Promise<void> {
    if (job.batchRequests === null) throw new Error('배치 요청 대응표가 없습니다');
    const prepared = await this.prepare(job);
    const { requests } = this.buildRequests(prepared, job.batchRequests);
    const results = await this.options.grader.collectBatch(batchId, new Map(requests.map((r) => [r.customId, r])));
    if (results === null) {
      await this.options.db.update(tables.gradingJobs).set({ lockedUntil: this.nextPoll() }).where(eq(tables.gradingJobs.id, job.id));
      return;
    }
    await this.finalize(job, prepared, job.batchRequests, results);
  }

  private nextPoll(): Date {
    return new Date(this.options.now().getTime() + this.options.batchPollSeconds * 1000);
  }

  private progress(prepared: PreparedJob, graded: number) {
    return { sessionsTotal: prepared.sessions.length, sessionsGraded: graded, skippedActive: prepared.skippedActive };
  }

  private async prepare(job: GradingJobRecord): Promise<PreparedJob> {
    const [examRow] = await this.options.db.select().from(tables.exams).where(eq(tables.exams.id, job.examId)).limit(1);
    if (examRow === undefined) throw new Error(`시험이 없습니다: ${job.examId}`);
    const exam: GradingExam = {
      id: examRow.id,
      slug: examRow.slug,
      definition: examRow.definition,
      grading: examRow.grading,
      rubrics: examRow.rubrics,
      answerKeys: examRow.answerKeys,
    };
    const materials = await this.loadCsvMaterials(examRow.slug, examRow.materialFiles);
    const sessionRows = await this.options.db
      .select({ id: tables.examSessions.id, status: tables.examSessions.status })
      .from(tables.examSessions)
      .where(eq(tables.examSessions.examId, job.examId))
      .orderBy(asc(tables.examSessions.id));
    const finished = sessionRows.filter((s) => s.status !== 'active');
    const sessions: PreparedSession[] = [];
    for (const s of finished) sessions.push(prepareSession(exam, materials, await loadSessionSnapshot(this.options.db, s.id)));
    return { exam, sessions, skippedActive: sessionRows.length - finished.length };
  }

  private async loadCsvMaterials(slug: string, files: Record<string, { kind: 'csv' | 'pdf'; file: string; sha256: string }>): Promise<Record<string, MaterialFacts>> {
    const facts: Record<string, MaterialFacts> = {};
    for (const [key, file] of Object.entries(files)) {
      if (file.kind !== 'csv') continue;
      const bytes = await readVerifiedMaterial(path.join(this.options.examsDir, slug), file);
      facts[key] = { kind: 'csv', table: parseCsvText(bytes.toString('utf8')) };
    }
    return facts;
  }

  /** LLM 요청과 custom_id 대응표를 만든다. 대응표가 주어지면(배치 수거) 그 id를 그대로 쓴다 */
  private buildRequests(prepared: PreparedJob, existing?: Record<string, { examSessionId: string; caseKey: string }>) {
    const idFor = new Map<string, string>();
    if (existing !== undefined) for (const [id, target] of Object.entries(existing)) idFor.set(`${target.examSessionId}/${target.caseKey}`, id);
    const requests: LlmGradingRequest[] = [];
    const requestMap: Record<string, { examSessionId: string; caseKey: string }> = {};
    for (const session of prepared.sessions) {
      for (const c of session.cases) {
        if (c.llm === null) continue;
        const target = { examSessionId: session.snapshot.sessionId, caseKey: c.context.caseDef.key };
        const customId = existing !== undefined ? idFor.get(`${target.examSessionId}/${target.caseKey}`) : `r${requests.length + 1}`;
        if (customId === undefined) throw new Error(`배치 대응표에 없는 채점 대상입니다: ${target.examSessionId}/${target.caseKey}`);
        requests.push(llmRequestOf(prepared.exam, c, customId));
        requestMap[customId] = target;
      }
    }
    return { requests, requestMap };
  }

  private resultsByTarget(requestMap: Record<string, { examSessionId: string; caseKey: string }>, results: readonly LlmGradingResult[]): Map<string, LlmGradingResult> {
    const byTarget = new Map<string, LlmGradingResult>();
    for (const result of results) {
      const target = requestMap[result.customId];
      if (target !== undefined) byTarget.set(`${target.examSessionId}/${target.caseKey}`, result);
    }
    return byTarget;
  }

  /** 세션 하나의 항목 점수·위반·총점을 트랜잭션으로 교체 저장한다(같은 작업의 재시도에도 결과가 한 벌만 남는다) */
  private async saveSession(job: GradingJobRecord, exam: GradingExam, session: PreparedSession, byTarget: ReadonlyMap<string, LlmGradingResult>): Promise<void> {
    const sessionId = session.snapshot.sessionId;
    const items = completeSession(session, (caseKey) => byTarget.get(`${sessionId}/${caseKey}`), this.options.grader.graderKind);
    const score = scoreSession(items, exam.definition.axisWeights, session.violations.length, exam.definition.violationPolicy);
    await this.options.db.transaction(async (tx) => {
      const scope = (table: typeof tables.gradeItems | typeof tables.violations | typeof tables.sessionScores) =>
        and(eq(table.gradingJobId, job.id), eq(table.examSessionId, sessionId));
      await tx.delete(tables.gradeItems).where(scope(tables.gradeItems));
      await tx.delete(tables.violations).where(scope(tables.violations));
      await tx.delete(tables.sessionScores).where(scope(tables.sessionScores));
      if (items.length > 0) {
        await tx.insert(tables.gradeItems).values(items.map((i) => ({ ...i, gradingJobId: job.id, examSessionId: sessionId, rubricVersion: exam.grading.rubricVersion })));
      }
      if (session.violations.length > 0) {
        await tx.insert(tables.violations).values(session.violations.map((v) => ({ ...v, gradingJobId: job.id, examSessionId: sessionId })));
      }
      await tx.insert(tables.sessionScores).values({ ...score, gradingJobId: job.id, examSessionId: sessionId });
    });
  }

  /** 배치 결과를 받은 뒤 모든 세션을 저장하고 작업을 끝낸다 */
  private async finalize(job: GradingJobRecord, prepared: PreparedJob, requestMap: Record<string, { examSessionId: string; caseKey: string }>, results: readonly LlmGradingResult[]): Promise<void> {
    const byTarget = this.resultsByTarget(requestMap, results);
    for (const session of prepared.sessions) await this.saveSession(job, prepared.exam, session, byTarget);
    await this.markDone(job, prepared, prepared.sessions.length, results.filter((r) => !r.ok).length);
  }

  private async markDone(job: GradingJobRecord, prepared: PreparedJob, graded: number, failedRequests: number): Promise<void> {
    await this.options.db
      .update(tables.gradingJobs)
      .set({
        status: 'done',
        finishedAt: this.options.now(),
        lockedUntil: null,
        progress: this.progress(prepared, graded),
        error: failedRequests > 0 ? `LLM 채점 요청 ${failedRequests}건이 실패해 해당 항목은 미채점입니다` : null,
      })
      .where(and(eq(tables.gradingJobs.id, job.id), ne(tables.gradingJobs.status, 'failed')));
    this.options.logger.info('grading_job_done', { jobId: job.id, sessions: graded, failedRequests });
  }
}
