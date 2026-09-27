import { tables, type Database } from '@ai-measurement/infra';
import {
  AXES,
  AXIS_LABELS,
  type AiProviderName,
  type ExamDetailResponse,
  type ExamListItem,
  type ExamSessionStatusName,
  type SessionListItem,
} from '@ai-measurement/shared';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { ExamCatalog } from '../exams/exam-catalog';
import type { GradingJobService } from './grading-job-service';
import { latestDoneJobId, scoresForJob } from './score-views';


/** 관리자 결과 페이지(PRD 8장): 시험 목록, 시험별 응시 현황·점수, 점수 CSV */
export class AdminResultsService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ExamCatalog,
    private readonly gradingJobs: GradingJobService,
    private readonly gradingLlmProvider: AiProviderName,
  ) {}

  async listExams(): Promise<ExamListItem[]> {
    const exams = await this.db
      .select({ id: tables.exams.id, slug: tables.exams.slug, title: tables.exams.title, status: tables.exams.status, importedAt: tables.exams.importedAt })
      .from(tables.exams)
      .orderBy(desc(tables.exams.importedAt));
    const candidateCounts = await this.db
      .select({ examId: tables.candidates.examId, n: count() })
      .from(tables.candidates)
      .groupBy(tables.candidates.examId);
    const sessionCounts = await this.db
      .select({ examId: tables.examSessions.examId, status: tables.examSessions.status, n: count() })
      .from(tables.examSessions)
      .groupBy(tables.examSessions.examId, tables.examSessions.status);
    return exams.map((exam) => {
      const counts: Record<ExamSessionStatusName, number> = { active: 0, submitted: 0, expired: 0 };
      for (const row of sessionCounts.filter((r) => r.examId === exam.id)) counts[row.status] = row.n;
      return {
        id: exam.id,
        slug: exam.slug,
        title: exam.title,
        status: exam.status,
        candidateCount: candidateCounts.find((c) => c.examId === exam.id)?.n ?? 0,
        sessionCounts: counts,
        importedAt: exam.importedAt.toISOString(),
      };
    });
  }

  async examDetail(examId: string): Promise<ExamDetailResponse> {
    const exam = await this.catalog.get(examId);
    return {
      id: exam.id,
      slug: exam.slug,
      title: exam.title,
      status: exam.status,
      packageSha256: exam.packageSha256,
      definition: exam.definition,
      sessions: await this.sessionList(examId),
      gradingJobs: await this.gradingJobs.list(examId),
      aiProvidersUsed: await this.aiProvidersUsed(examId),
      gradingLlmProvider: this.gradingLlmProvider,
    };
  }

  /** 응시 AI 공급자는 수험생 서버 설정이므로 관리자 서버는 메시지에 남은 기록으로만 안다 */
  private async aiProvidersUsed(examId: string): Promise<AiProviderName[]> {
    const rows = await this.db
      .selectDistinct({ provider: tables.messages.provider })
      .from(tables.messages)
      .innerJoin(tables.examSessions, eq(tables.examSessions.id, tables.messages.examSessionId))
      .where(and(eq(tables.examSessions.examId, examId), eq(tables.messages.role, 'assistant')))
      .orderBy(asc(tables.messages.provider));
    return rows.map((r) => r.provider);
  }

  private async sessionList(examId: string): Promise<SessionListItem[]> {
    const rows = await this.db
      .select({ candidate: { candidateNo: tables.candidates.candidateNo }, session: tables.examSessions })
      .from(tables.candidates)
      .leftJoin(tables.examSessions, eq(tables.examSessions.candidateId, tables.candidates.id))
      .where(eq(tables.candidates.examId, examId))
      .orderBy(asc(tables.candidates.candidateNo));
    const sessionIds = rows.flatMap((r) => (r.session !== null ? [r.session.id] : []));
    const balances = await this.latestBalances(sessionIds);
    const jobId = await latestDoneJobId(this.db, examId);
    const scores = jobId !== null ? await scoresForJob(this.db, jobId, sessionIds) : new Map();
    return rows.map(({ candidate, session }) => {
      if (session === null) {
        return { examSessionId: null, candidateNo: candidate.candidateNo, status: 'not_started', startedAt: null, expiresAt: null, tokenUsed: null, score: null };
      }
      const balance = balances.get(session.id);
      if (balance === undefined) throw new Error(`토큰 원장이 비어 있는 세션입니다: ${session.id}`);
      return {
        examSessionId: session.id,
        candidateNo: candidate.candidateNo,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        tokenUsed: session.tokenBudget - balance,
        score: scores.get(session.id) ?? null,
      };
    });
  }

  private async latestBalances(sessionIds: readonly string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([tables.tokenLedger.examSessionId], { sessionId: tables.tokenLedger.examSessionId, balance: tables.tokenLedger.balanceAfter })
      .from(tables.tokenLedger)
      .where(inArray(tables.tokenLedger.examSessionId, [...sessionIds]))
      .orderBy(tables.tokenLedger.examSessionId, desc(tables.tokenLedger.id));
    return new Map(rows.map((r) => [r.sessionId, r.balance]));
  }

  /** 점수표 CSV(엑셀용 BOM 포함). 미채점은 빈칸이 아니라 '미채점'으로 적는다 */
  async scoresCsv(examId: string): Promise<string> {
    const sessions = await this.sessionList(examId);
    const header = ['응시번호', '상태', '사용 토큰', '총점', ...AXES.map((a) => AXIS_LABELS[a]), '중대 위반 건수', '판정', '채점 방식'];
    const cell = (value: number | null | undefined, graded: boolean) => (graded ? (value === null || value === undefined ? '미채점' : value.toFixed(1)) : '');
    const lines = sessions.map((s) => {
      const score = s.score;
      return [
        s.candidateNo,
        s.status,
        s.tokenUsed === null ? '' : String(s.tokenUsed),
        cell(score?.total, score !== null),
        ...AXES.map((axis) => cell(score?.axisPercent[axis], score !== null)),
        score === null ? '' : String(score.violationCount),
        score?.outcome ?? '',
        score?.graderKinds.join('+') ?? '',
      ];
    });
    const escape = (value: string) => (/[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value);
    return `﻿${[header, ...lines].map((line) => line.map(escape).join(',')).join('\n')}\n`;
  }
}
