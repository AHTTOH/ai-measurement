import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GradingJobRunner, MockGrader, type LlmGrader } from '@ai-measurement/grading';
import { silentLogger, tables } from '@ai-measurement/infra';
import type { CandidateStateResponse, ExamDetailResponse, SessionDetailResponse } from '@ai-measurement/shared';
import { eq } from 'drizzle-orm';
import { createTestServer, prepareOpenExam, repoRoot, TestClient, waitForResponse, type TestServer } from './support/test-server';

let server: TestServer;
let admin: TestClient;
let examId: string;
let sessionId: string;

function runner(grader: LlmGrader): GradingJobRunner {
  return new GradingJobRunner({
    db: server.roles.gradingWorker,
    examsDir: path.join(repoRoot, 'exams'),
    grader,
    logger: silentLogger,
    now: () => server.clock.now(),
    directConcurrency: 2,
    jobLockMinutes: 10,
    batchPollSeconds: 30,
  });
}

beforeEach(async () => {
  server = await createTestServer();
  const prepared = await prepareOpenExam(server);
  examId = prepared.examId;
  const [adminRow] = await server.db.select().from(tables.admins);
  admin = new TestClient(server.apps);
  await admin.loginAdmin(adminRow!.username, 'admin-password-1');

  const candidate = new TestClient(server.apps);
  await candidate.loginCandidate(prepared.candidates[0]!.candidateNo, prepared.candidates[0]!.pin);
  const state = (await candidate.request<CandidateStateResponse>('POST', '/api/candidate/session/start')).body.data;
  sessionId = state.session!.id;
  const hrConversation = state.conversations.find((c) => c.caseKey === 'hr-survey')!.id;
  // 주민등록번호 컬럼까지 통째로 보낸다(중대 위반)
  await candidate.request('POST', `/api/candidate/conversations/${hrConversation}/messages`, {
    clientMessageId: randomUUID(),
    subquestionKey: '1-3',
    text: '부서별로 분석해줘',
    attachments: [{ kind: 'csv', materialKey: 'employees', columns: ['주민등록번호', '부서', '직무만족도', '이직의향'], rowIndexes: [0, 1, 2, 3, 4] }],
  });
  await waitForResponse(server.candidate, hrConversation);
  await candidate.request('POST', '/api/candidate/answers/1-1/submit', { content: { kind: 'multi_choice', selected: ['name', 'rrn', 'phone', 'note'] } });
  await candidate.request('POST', '/api/candidate/session/submit');
});
afterEach(async () => {
  await server.close();
});

describe('채점 작업', () => {
  it('즉시 모드: 규칙·모의 LLM 결과와 중대 위반을 저장하고 관리자 화면에 점수를 보여준다', async () => {
    expect((await admin.request('POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'direct' })).status).toBe(201);
    expect(await runner(new MockGrader()).runOnce()).toBe(true);

    const [job] = await server.db.select().from(tables.gradingJobs);
    expect(job?.status).toBe('done');
    expect(job?.progress).toEqual({ sessionsTotal: 1, sessionsGraded: 1, skippedActive: 0 });

    const detail = (await admin.request<SessionDetailResponse>('GET', `/api/admin/sessions/${sessionId}`)).body.data;
    expect(detail.latestScore?.status).toBe('graded');
    expect(detail.latestScore?.graderKinds).toEqual(['llm-mock', 'rule']);
    expect(detail.latestScore?.outcome).toBe('review');
    const rrnRule = detail.gradeItems.find((i) => i.itemId === 'j-no-rrn');
    expect(rrnRule?.earned).toBe(0);
    const choice = detail.gradeItems.find((i) => i.itemId === 'j-choice');
    expect(choice?.earned).toBe(8);
    expect(detail.violations.find((v) => v.source === 'column')).toMatchObject({ tag: 'pii', label: '직원 주민등록번호', count: 5 });

    const exam = (await admin.request<ExamDetailResponse>('GET', `/api/admin/exams/${examId}`)).body.data;
    expect(exam.sessions[0]?.score?.total).not.toBeNull();
    const csv = await (await admin.raw('GET', `/api/admin/exams/${examId}/scores.csv`)).text();
    expect(csv).toContain('review');
  });

  it('배치 모드: 제출 후 대기 상태가 되고, 다음 확인 때 결과를 모아 끝낸다', async () => {
    await admin.request('POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'batch' });
    const grader = new MockGrader();
    const worker = runner(grader);
    expect(await worker.runOnce()).toBe(true);
    let [job] = await server.db.select().from(tables.gradingJobs);
    expect(job?.status).toBe('waiting_batch');
    expect(job?.batchId).toMatch(/^mock_batch_/);
    expect(await worker.runOnce()).toBe(false); // 확인 시각 전에는 잡지 않는다
    server.clock.advanceMinutes(1);
    expect(await worker.runOnce()).toBe(true);
    [job] = await server.db.select().from(tables.gradingJobs);
    expect(job?.status).toBe('done');
    expect(await server.db.select().from(tables.sessionScores).where(eq(tables.sessionScores.gradingJobId, job!.id))).toHaveLength(1);
  });

  it('즉시 모드 작업을 다시 잡으면 이미 점수를 저장한 세션은 LLM을 다시 부르지 않는다', async () => {
    // 두 번째 응시자도 응시를 끝낸다
    const second = (await server.admin.examAdmin.generateCandidates(examId, 'S', 1, (await server.db.select().from(tables.admins))[0]!.id))[0]!;
    const candidate = new TestClient(server.apps, '10.0.0.2');
    await candidate.loginCandidate(second.candidateNo, second.pin);
    await candidate.request('POST', '/api/candidate/session/start');
    await candidate.request('POST', '/api/candidate/session/submit');

    await admin.request('POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'direct' });
    const [job] = await server.db.select().from(tables.gradingJobs);
    // 첫 세션만 저장된 채 워커가 멈춘 상황을 만든다
    await server.db.insert(tables.sessionScores).values({
      gradingJobId: job!.id,
      examSessionId: sessionId,
      status: 'graded',
      total: 50,
      axisPercent: { judgment: 50, usage: 50, output: 50 },
      violationCount: 0,
      outcome: 'clear',
    });
    await server.db.update(tables.gradingJobs).set({ status: 'running', lockedUntil: new Date(server.clock.now().getTime() - 1000) }).where(eq(tables.gradingJobs.id, job!.id));

    const counting = new MockGrader();
    const calledFor: string[] = [];
    const original = counting.gradeNow.bind(counting);
    counting.gradeNow = async (requests) => {
      calledFor.push(...requests.map((r) => r.candidateBlock.length > 0 ? 'call' : 'empty'));
      return original(requests);
    };
    expect(await runner(counting).runOnce()).toBe(true);
    const [finished] = await server.db.select().from(tables.gradingJobs);
    expect(finished?.status).toBe('done');
    expect(calledFor).toHaveLength(3); // 남은 세션 하나의 Case 3개만 채점
    const scores = await server.db.select().from(tables.sessionScores).where(eq(tables.sessionScores.gradingJobId, job!.id));
    expect(scores).toHaveLength(2);
    expect(scores.find((s) => s.examSessionId === sessionId)?.total).toBe(50); // 이미 저장한 결과는 건드리지 않았다
  });

  it('작업의 채점 공급자와 워커 설정이 다르면 작업을 실패로 남긴다', async () => {
    await admin.request('POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'direct' });
    const wrongProvider: LlmGrader = Object.assign(Object.create(MockGrader.prototype) as MockGrader, { provider: 'anthropic' as const });
    expect(await runner(wrongProvider).runOnce()).toBe(true);
    const [job] = await server.db.select().from(tables.gradingJobs);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('채점 공급자');
  });
});
