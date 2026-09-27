import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tables } from '@ai-measurement/infra';
import type { CandidateStateResponse, ExamDetailResponse, ExamPackageListItem, GeneratedCandidate, SendMessageResponse, SessionDetailResponse } from '@ai-measurement/shared';
import { eq } from 'drizzle-orm';
import { createAdmin, createTestServer, repoRoot, SAMPLE_SLUG, TestClient, waitForResponse, type TestServer } from './support/test-server';

let server: TestServer;
let admin: TestClient;
let adminId: string;

beforeEach(async () => {
  server = await createTestServer();
  const created = await createAdmin(server.db);
  adminId = created.id;
  admin = new TestClient(server.apps);
  await admin.loginAdmin(created.username, created.password);
});
afterEach(async () => {
  await server.close();
});

async function readPackageFiles(dir: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, await readPackageFiles(dir, relative));
    else files[relative] = new Uint8Array(await readFile(path.join(dir, relative)));
  }
  return files;
}

describe('관리자: 시험 등록과 운영', () => {
  it('관리자가 아니면 관리자 API를 쓸 수 없다', async () => {
    const anonymous = new TestClient(server.apps);
    expect((await anonymous.request('GET', '/api/admin/exams')).status).toBe(401);
  });

  it('exams 폴더의 패키지를 검증 결과와 함께 보여주고 등록한다', async () => {
    const packages = await admin.request<ExamPackageListItem[]>('GET', '/api/admin/exam-packages');
    const sample = packages.body.data.find((p) => p.slug === SAMPLE_SLUG);
    expect(sample?.ok).toBe(true);
    const imported = await admin.request<{ examId: string; replaced: boolean }>('POST', '/api/admin/exams/import-directory', { slug: SAMPLE_SLUG });
    expect(imported.status).toBe(201);
    expect(imported.body.data.replaced).toBe(false);
    const again = await admin.request<{ examId: string; replaced: boolean }>('POST', '/api/admin/exams/import-directory', { slug: SAMPLE_SLUG });
    expect(again.body.data).toEqual({ examId: imported.body.data.examId, replaced: true });
  });

  it('열린 시험은 다시 등록할 수 없고 상태는 초안→진행→종료로만 바뀐다', async () => {
    const { examId } = (await admin.request<{ examId: string }>('POST', '/api/admin/exams/import-directory', { slug: SAMPLE_SLUG })).body.data;
    expect((await admin.request('POST', `/api/admin/exams/${examId}/status`, { status: 'closed' })).status).toBe(409);
    expect((await admin.request('POST', `/api/admin/exams/${examId}/status`, { status: 'open' })).status).toBe(200);
    expect((await admin.request('POST', '/api/admin/exams/import-directory', { slug: SAMPLE_SLUG })).status).toBe(409);
  });

  it('응시번호를 이어서 발급하고 PIN은 해시로만 저장한다', async () => {
    const { examId } = (await admin.request<{ examId: string }>('POST', '/api/admin/exams/import-directory', { slug: SAMPLE_SLUG })).body.data;
    const first = await admin.request<GeneratedCandidate[]>('POST', `/api/admin/exams/${examId}/candidates`, { prefix: 'A', count: 3 });
    const second = await admin.request<GeneratedCandidate[]>('POST', `/api/admin/exams/${examId}/candidates`, { prefix: 'A', count: 2 });
    expect([...first.body.data, ...second.body.data].map((c) => c.candidateNo)).toEqual(['A0001', 'A0002', 'A0003', 'A0004', 'A0005']);
    const rows = await server.db.select().from(tables.candidates);
    expect(rows.every((r) => r.pinHash.startsWith('scrypt$') && !r.pinHash.includes(first.body.data[0]!.pin))).toBe(true);
  });

  it('zip 패키지를 검증해 exams/<slug>로 풀고 등록한다. 허용되지 않은 경로가 있으면 거부한다', async () => {
    const slug = `zip-test-${randomUUID().slice(0, 8)}`;
    const files = await readPackageFiles(path.join(repoRoot, 'exams', SAMPLE_SLUG));
    const examJson = JSON.parse(Buffer.from(files['exam.json']!).toString('utf8')) as { slug: string };
    examJson.slug = slug;
    files['exam.json'] = new TextEncoder().encode(JSON.stringify(examJson));
    try {
      const bad = zipSync({ ...files, '../escape.txt': new TextEncoder().encode('x') });
      const rejected = await admin.raw('POST', '/api/admin/exams/import-zip', undefined, { 'content-type': 'application/zip' });
      expect(rejected.status).toBe(400); // 빈 본문
      const badResponse = await server.apps.admin.request('/api/admin/exams/import-zip', { method: 'POST', body: bad, headers: { 'content-type': 'application/zip', cookie: await adminCookie() } });
      expect(badResponse.status).toBe(422);

      const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [`${slug}/${name}`, data])));
      const response = await server.apps.admin.request('/api/admin/exams/import-zip', { method: 'POST', body: zip, headers: { 'content-type': 'application/zip', cookie: await adminCookie() } });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { slug: string } };
      expect(body.data.slug).toBe(slug);
    } finally {
      await rm(path.join(repoRoot, 'exams', slug), { recursive: true, force: true });
      await rm(path.join(repoRoot, 'exams', '.uploads'), { recursive: true, force: true });
    }
  });

  it('응시 상세에 대화·원장·답안·시간 기록이 모두 담기고, 메시지 토큰을 한 번만 환불할 수 있다', async () => {
    const { examId } = (await admin.request<{ examId: string }>('POST', '/api/admin/exams/import-directory', { slug: SAMPLE_SLUG })).body.data;
    await admin.request('POST', `/api/admin/exams/${examId}/status`, { status: 'open' });
    const [candidate] = (await admin.request<GeneratedCandidate[]>('POST', `/api/admin/exams/${examId}/candidates`, { prefix: 'R', count: 1 })).body.data;
    const candidateClient = new TestClient(server.apps);
    await candidateClient.loginCandidate(candidate!.candidateNo, candidate!.pin);
    const state = (await candidateClient.request<CandidateStateResponse>('POST', '/api/candidate/session/start')).body.data;
    const conversationId = state.conversations.find((c) => c.caseKey === 'hr-survey')!.id;
    const sent = await candidateClient.request<SendMessageResponse>('POST', `/api/candidate/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      subquestionKey: '1-3',
      text: '분석해줘',
      attachments: [],
    });
    expect(sent.status).toBe(201);
    await waitForResponse(server.candidate, conversationId);
    await candidateClient.request('PUT', '/api/candidate/answers/1-2', { content: { kind: 'text', text: '답' } });

    const detail = await admin.request<SessionDetailResponse>('GET', `/api/admin/sessions/${state.session!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.conversations.find((c) => c.caseKey === 'hr-survey')!.messages).toHaveLength(2);
    expect(detail.body.data.ledger.map((l) => l.reason)).toEqual(['initial', 'message']);
    expect(detail.body.data.answers).toHaveLength(1);
    expect(detail.body.data.timeline.some((t) => t.kind === 'session_started')).toBe(true);

    const refund = await admin.request<{ tokenBalance: number }>('POST', `/api/admin/sessions/${state.session!.id}/refund`, { messageId: sent.body.data.userMessage.id, reason: '장애' });
    expect(refund.body.data.tokenBalance).toBe(40_000);
    expect((await admin.request('POST', `/api/admin/sessions/${state.session!.id}/refund`, { messageId: sent.body.data.userMessage.id, reason: '중복' })).status).toBe(409);

    const exam = await admin.request<ExamDetailResponse>('GET', `/api/admin/exams/${examId}`);
    expect(exam.body.data.sessions[0]).toMatchObject({ candidateNo: 'R0001', status: 'active', tokenUsed: 0 });
    const csv = await admin.raw('GET', `/api/admin/exams/${examId}/scores.csv`);
    expect((await csv.text()).split('\n')[0]).toContain('응시번호');
  });

  it('채점 작업은 종료된 세션이 있어야 만들 수 있고 동시에 하나만 진행한다', async () => {
    const { examId } = (await admin.request<{ examId: string }>('POST', '/api/admin/exams/import-directory', { slug: SAMPLE_SLUG })).body.data;
    expect((await admin.request('POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'direct' })).body.error.code).toBe('no_finished_sessions');
    await admin.request('POST', `/api/admin/exams/${examId}/status`, { status: 'open' });
    const [candidate] = (await admin.request<GeneratedCandidate[]>('POST', `/api/admin/exams/${examId}/candidates`, { prefix: 'G', count: 1 })).body.data;
    const candidateClient = new TestClient(server.apps);
    await candidateClient.loginCandidate(candidate!.candidateNo, candidate!.pin);
    await candidateClient.request('POST', '/api/candidate/session/start');
    await candidateClient.request('POST', '/api/candidate/session/submit');
    expect((await admin.request('POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'direct' })).status).toBe(201);
    expect((await admin.request('POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'batch' })).body.error.code).toBe('grading_in_progress');
    const [job] = await server.db.select().from(tables.gradingJobs).where(eq(tables.gradingJobs.examId, examId));
    expect(job?.llmProvider).toBe('mock');
    expect(adminId).toBeTruthy();
  });
});

async function adminCookie(): Promise<string> {
  const response = await admin.raw('GET', '/api/admin/me');
  expect(response.status).toBe(200);
  return (admin as unknown as { cookies: Map<string, string> }).cookies.size > 0
    ? [...(admin as unknown as { cookies: Map<string, string> }).cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    : '';
}
