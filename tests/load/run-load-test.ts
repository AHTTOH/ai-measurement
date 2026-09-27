/**
 * 부하 테스트(구현계획 P6): 가상 응시자 N명이 동시에 시작해 AI 전송·답안 자동저장·상태 조회를 반복한다.
 * 전용 DB·서버를 띄우고 모의 AI로 돈다. 우리 서버·DB의 병목을 보는 시험이며, 실제 Claude API 지연·한도는 재지 않는다.
 * 실행: npx tsx tests/load/run-load-test.ts <응시자수> <초> <수험생서버대수> <프로필>
 * - 프로필 burst: 2~5초마다 행동하는 과부하 시험(병목 찾기)
 * - 프로필 rehearsal: 20~60초마다 행동하는 실제 시험 흉내(120분 리허설용). 끝나면 채점 워커로 채점까지 돌려 시간을 잰다
 * 수험생 서버가 2대 이상이면 라운드로빈 프록시 뒤에 둔다(세션 고정 없음, 결정 2026-09-27 수험생 서버 다중 인스턴스).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { freePort, repoRoot, startIsolatedStack } from '../support/isolated-stack';
import { startCpuProfile, type HotFunction } from './cpu-profiler';
import { startDatabaseWaitSampler, type WaitSamplerResult } from './database-wait-sampler';

const USAGE = '실행: npx tsx tests/load/run-load-test.ts <응시자수> <초> <수험생서버대수> <burst|rehearsal>';

interface LoadProfile {
  thinkMinMs: number;
  thinkMaxMs: number;
  /** 행동 비율: AI 전송, 답안 자동저장(나머지는 상태 조회) */
  sendRatio: number;
  saveRatio: number;
  /** 끝난 뒤 채점 워커로 즉시 채점을 돌려 걸린 시간을 잰다 */
  gradeAfter: boolean;
}

const PROFILES: Readonly<Record<string, LoadProfile>> = {
  burst: { thinkMinMs: 2_000, thinkMaxMs: 5_000, sendRatio: 0.35, saveRatio: 0.4, gradeAfter: false },
  rehearsal: { thinkMinMs: 20_000, thinkMaxMs: 60_000, sendRatio: 0.35, saveRatio: 0.4, gradeAfter: true },
};
/** 채점이 끝나기를 기다리는 간격과 한도 */
const GRADING_POLL_MS = 5_000;
const GRADING_TIMEOUT_MS = 60 * 60 * 1000;

function positiveIntegerArg(index: number, name: string): number {
  const value = Number(process.argv[index]);
  if (!Number.isInteger(value) || value < 1) {
    process.stderr.write(`${name}가 필요합니다(양의 정수). ${USAGE}\n`);
    process.exit(1);
  }
  return value;
}

const CANDIDATES = positiveIntegerArg(2, '응시자수');
const DURATION_SECONDS = positiveIntegerArg(3, '초');
const CANDIDATE_INSTANCES = positiveIntegerArg(4, '수험생서버대수');
function profileArg(index: number): { name: string; profile: LoadProfile } {
  const name = process.argv[index];
  const profile = name === undefined ? undefined : PROFILES[name];
  if (name === undefined || profile === undefined) {
    process.stderr.write(`프로필은 ${Object.keys(PROFILES).join(' 또는 ')}입니다. ${USAGE}\n`);
    process.exit(1);
  }
  return { name, profile };
}

const { name: PROFILE_NAME, profile: PROFILE } = profileArg(5);
/** 설정하면 이 간격(ms)으로 DB 연결 대기 상태를 표본 수집해 결과에 넣는다(병목 진단용) */
const DB_SAMPLING_MS = process.env['LOAD_TEST_DB_SAMPLING_MS'] === undefined ? null : Number(process.env['LOAD_TEST_DB_SAMPLING_MS']);
/** '1'이면 수험생 서버의 CPU 프로파일을 떠서 자기 시간이 긴 함수를 결과에 넣고 .cpuprofile 파일을 남긴다 */
const CPU_PROFILE = process.env['LOAD_TEST_CPU_PROFILE'] === '1';
const MOCK_CHUNK_DELAY_MS = '40';

/** at: 부하 시작 기준으로 요청을 보낸 시각(ms) */
type Sample = { name: string; ms: number; status: number; at: number };
const samples: Sample[] = [];
/** 부하 시작 시각(performance.now 기준). 응시자 전원이 동시에 로그인하는 첫 구간과 이후를 나눠 보기 위해 쓴다 */
let loadStartedAt = 0;
/** 이 시간(초)까지를 시작 폭주 구간으로 보고 정상 구간 통계에서 뺀다 */
const OPENING_BURST_SECONDS = 15;
/** 이보다 느린 요청은 시각과 함께 결과에 남긴다(주기적인 멈춤을 찾는 용도) */
const SLOW_SAMPLE_MS = 1000;

class Client {
  private cookie = '';
  constructor(private readonly baseUrl: string) {}

  async call<T>(name: string, method: string, url: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const started = performance.now();
    let status = 0;
    try {
      const response = await fetch(this.baseUrl + url, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      status = response.status;
      const setCookie = response.headers.getSetCookie()[0];
      if (setCookie !== undefined) this.cookie = setCookie.split(';')[0] ?? '';
      const json = (await response.json()) as { ok: boolean; data: T };
      return { status, data: json.ok ? json.data : null };
    } catch {
      return { status, data: null };
    } finally {
      samples.push({ name, ms: performance.now() - started, status, at: started - loadStartedAt });
    }
  }

  /** SSE를 끝(done·failed·idle)까지 읽고 첫 조각·완료까지 걸린 시간을 기록한다 */
  async followStream(conversationId: string, sentAt: number): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/candidate/conversations/${conversationId}/stream`, { headers: { cookie: this.cookie } });
    if (response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstDelta = true;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const event = /event: ?(\w+)/u.exec(buffer.slice(0, boundary))?.[1];
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        if ((event === 'delta' || event === 'snapshot') && firstDelta) {
          firstDelta = false;
          samples.push({ name: 'ai_first_text', ms: performance.now() - sentAt, status: 200, at: sentAt - loadStartedAt });
        }
        if (event === 'done' || event === 'failed' || event === 'idle') {
          samples.push({ name: `ai_complete_${event}`, ms: performance.now() - sentAt, status: event === 'failed' ? 500 : 200, at: sentAt - loadStartedAt });
          await reader.cancel();
          return;
        }
      }
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);
const randomId = () => crypto.randomUUID();

interface StateLike {
  conversations: Array<{ id: string; caseKey: string; status: string }>;
  cases: Array<{ key: string; subquestions: Array<{ key: string; answer: { kind: string } }> }>;
}

async function virtualCandidate(baseUrl: string, candidateNo: string, pin: string, deadline: number): Promise<void> {
  const client = new Client(baseUrl);
  await client.call('login', 'POST', '/api/candidate/login', { candidateNo, pin });
  const started = await client.call<StateLike>('session_start', 'POST', '/api/candidate/session/start', {});
  const state = started.data;
  if (state === null) return;
  const hr = state.conversations.find((c) => c.caseKey === 'hr-survey');
  const textSubs = state.cases.flatMap((c) => c.subquestions.filter((s) => s.answer.kind === 'text').map((s) => s.key));
  let draft = '';
  while (Date.now() < deadline) {
    await sleep(between(PROFILE.thinkMinMs, PROFILE.thinkMaxMs));
    const roll = Math.random();
    if (roll < PROFILE.sendRatio && hr !== undefined) {
      const attach = Math.random() < 0.3;
      const sentAt = performance.now();
      const sent = await client.call('ai_send', 'POST', `/api/candidate/conversations/${hr.id}/messages`, {
        clientMessageId: randomId(),
        subquestionKey: '1-3',
        text: '부서별 평균 직무만족도와 이직의향 비율을 계산해 표로 정리해 주세요.',
        attachments: attach ? [{ kind: 'csv', materialKey: 'employees', columns: ['부서', '직무만족도', '이직의향'], rowIndexes: Array.from({ length: 48 }, (_, i) => i) }] : [],
      });
      if (sent.status === 201) await client.followStream(hr.id, sentAt);
    } else if (roll < PROFILE.sendRatio + PROFILE.saveRatio) {
      draft += ' 분석 결과를 정리한다.';
      const key = textSubs[Math.floor(Math.random() * textSubs.length)] ?? '1-2';
      await client.call('answer_save', 'PUT', `/api/candidate/answers/${key}`, { content: { kind: 'text', text: draft } });
    } else {
      await client.call('state_poll', 'GET', '/api/candidate/state');
    }
  }
  await client.call('session_submit', 'POST', '/api/candidate/session/submit', {});
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function rowsOf(selected: Sample[]) {
  const names = [...new Set(selected.map((s) => s.name))].sort();
  return names.map((name) => {
    const group = selected.filter((s) => s.name === name);
    const ms = group.map((s) => s.ms).sort((a, b) => a - b);
    const errors = group.filter((s) => s.status < 200 || s.status >= 300);
    const byStatus = Object.fromEntries([...new Set(errors.map((e) => e.status))].map((st) => [st, errors.filter((e) => e.status === st).length]));
    return { name, count: group.length, errors: errors.length, errorStatuses: byStatus, p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), max: ms.at(-1) ?? 0 };
  });
}

function summarize(elapsedSeconds: number) {
  const rows = rowsOf(samples);
  /** 시작 폭주(전원 동시 로그인·응시 시작)가 지난 뒤의 통계. 실제 시험은 로그인이 몇 분에 걸쳐 흩어진다 */
  const steadyRows = rowsOf(samples.filter((s) => s.at >= OPENING_BURST_SECONDS * 1000));
  const requests = samples.filter((s) => !s.name.startsWith('ai_first') && !s.name.startsWith('ai_complete')).length;
  const slowSamples = samples
    .filter((s) => s.at >= OPENING_BURST_SECONDS * 1000 && s.ms >= SLOW_SAMPLE_MS)
    .map((s) => ({ name: s.name, atSeconds: Number((s.at / 1000).toFixed(2)), ms: Math.round(s.ms) }))
    .sort((a, b) => a.atSeconds - b.atSeconds);
  return { profile: PROFILE_NAME, candidates: CANDIDATES, durationSeconds: DURATION_SECONDS, candidateInstances: CANDIDATE_INSTANCES, elapsedSeconds, requestsPerSecond: requests / elapsedSeconds, rows, openingBurstSeconds: OPENING_BURST_SECONDS, steadyRows, slowSamples };
}

interface GradingResult {
  status: string;
  seconds: number;
  progress: unknown;
  error: string | null;
}

/** 응시가 모두 끝난 뒤 즉시 채점을 돌리고 끝날 때까지 기다린다(모의 채점기) */
async function gradeAll(admin: Client, examId: string): Promise<GradingResult> {
  const started = Date.now();
  const created = await admin.call<{ id: string }>('admin_grading_create', 'POST', `/api/admin/exams/${examId}/grading-jobs`, { llmMode: 'direct' });
  if (created.data === null) throw new Error(`채점 작업을 만들지 못했습니다(상태 ${created.status})`);
  const jobId = created.data.id;
  while (Date.now() - started < GRADING_TIMEOUT_MS) {
    await sleep(GRADING_POLL_MS);
    const detail = await admin.call<{ gradingJobs: Array<{ id: string; status: string; progress: unknown; error: string | null }> }>('admin_exam_detail', 'GET', `/api/admin/exams/${examId}`);
    const job = detail.data?.gradingJobs.find((j) => j.id === jobId);
    if (job !== undefined && (job.status === 'done' || job.status === 'failed')) {
      return { status: job.status, seconds: (Date.now() - started) / 1000, progress: job.progress, error: job.error };
    }
  }
  return { status: 'timeout', seconds: (Date.now() - started) / 1000, progress: null, error: `${GRADING_TIMEOUT_MS / 60_000}분 안에 끝나지 않았습니다` };
}

async function main(): Promise<void> {
  const stack = await startIsolatedStack({
    label: 'load',
    candidatePort: await freePort(),
    candidateInstances: CANDIDATE_INSTANCES,
    adminPort: await freePort(),
    candidateEnv: { MOCK_AI_CHUNK_DELAY_MS: MOCK_CHUNK_DELAY_MS, CANDIDATE_AI_REQUESTS_PER_MINUTE: '30' },
    withWorker: PROFILE.gradeAfter,
    inspectCandidates: CPU_PROFILE,
  });
  try {
    const admin = new Client(stack.adminUrl);
    await admin.call('admin_login', 'POST', '/api/admin/login', stack.admin);
    const imported = await admin.call<{ examId: string }>('admin_import', 'POST', '/api/admin/exams/import-directory', { slug: 'sample-ai-practice' });
    if (imported.data === null) throw new Error('시험 등록 실패');
    await admin.call('admin_open', 'POST', `/api/admin/exams/${imported.data.examId}/status`, { status: 'open' });
    const generated = await admin.call<Array<{ candidateNo: string; pin: string }>>('admin_generate', 'POST', `/api/admin/exams/${imported.data.examId}/candidates`, { prefix: 'LOAD', count: CANDIDATES });
    if (generated.data === null) throw new Error('응시자 발급 실패');
    samples.length = 0;

    process.stdout.write(`가상 응시자 ${CANDIDATES}명, ${DURATION_SECONDS}초, 수험생 서버 ${CANDIDATE_INSTANCES}대, 프로필 ${PROFILE_NAME}\n`);
    const profilers = await Promise.all(stack.candidateInspectPorts.map((port) => startCpuProfile(port)));
    const startedAt = Date.now();
    loadStartedAt = performance.now();
    const sampler = DB_SAMPLING_MS === null ? null : startDatabaseWaitSampler(stack.ownerConnection, DB_SAMPLING_MS, loadStartedAt);
    const deadline = startedAt + DURATION_SECONDS * 1000;
    await Promise.all(generated.data.map((c) => virtualCandidate(stack.candidateUrl, c.candidateNo, c.pin, deadline)));
    const sampled: WaitSamplerResult | null = sampler === null ? null : await sampler.stop();
    const databaseWaits = sampled === null ? null : { top: sampled.top.slice(0, 25), timeline: sampled.timeline.filter((p) => Object.keys(p.waits).length > 0 || p.maintenance.length > 0) };
    const profiles = await Promise.all(profilers.map((p) => p.stop()));
    const cpuHotFunctions: HotFunction[][] = profiles.map((p) => p.hot);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const grading = PROFILE.gradeAfter ? await gradeAll(admin, imported.data.examId) : null;
    const summary = { ...summarize(elapsedSeconds), grading, databaseWaits, cpuHotFunctions };

    const outDir = path.join(repoRoot, 'workspace', 'load-test');
    await mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `load-test-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await writeFile(outFile, JSON.stringify(summary, null, 2));
    for (const [index, p] of profiles.entries()) await writeFile(outFile.replace(/\.json$/u, `-candidate-${index + 1}.cpuprofile`), JSON.stringify(p.profile));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n결과 파일: ${outFile}\n`);
  } finally {
    await stack.stop();
  }
}

await main();
