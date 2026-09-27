import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tables, type Database } from '@ai-measurement/infra';
import { sql } from 'drizzle-orm';
import { createTestServer, prepareOpenExam, TestClient, waitForResponse, type TestServer } from './support/test-server';

/**
 * 권한 구조 분리(docs/decisions/2026-09-27-권한-구조-분리.md)가 DB 수준에서 지켜지는지 확인한다.
 * 서버 코드가 뚫려도 DB 역할이 막아야 하는 것들이다.
 */
const INSUFFICIENT_PRIVILEGE = '42501';
const APPEND_ONLY_TABLES = ['messages', 'token_ledger', 'answers', 'audit_events'] as const;

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer();
  const { candidates } = await prepareOpenExam(server, 1);
  const client = new TestClient(server.apps);
  await client.loginCandidate(candidates[0]!.candidateNo, candidates[0]!.pin);
  await client.request('POST', '/api/candidate/session/start');
  const [conversation] = await server.db.select().from(tables.conversations).limit(1);
  const sent = await client.request('POST', `/api/candidate/conversations/${conversation!.id}/messages`, { clientMessageId: randomUUID(), subquestionKey: null, text: '안녕하세요', attachments: [] });
  expect(sent.status).toBe(201);
  await waitForResponse(server.candidate, conversation!.id);
  // 샘플 시험의 1-2는 서술형(text) 하위문항이다
  expect((await client.request('PUT', '/api/candidate/answers/1-2', { content: { kind: 'text', text: '답안' } })).status).toBe(200);
});
afterEach(async () => {
  await server.close();
});

function postgresCode(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function expectDenied(db: Database, statement: ReturnType<typeof sql>): Promise<void> {
  const error = await db.execute(statement).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `권한 오류가 나야 합니다: ${statement.queryChunks.map(String).join('')}`).not.toBeNull();
  expect(postgresCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
}

describe('수험생 서버 DB 역할', () => {
  it('루브릭·정답·관리자 계정·채점 결과를 읽을 수 없다', async () => {
    const db = server.roles.candidateServer;
    await expectDenied(db, sql`SELECT rubrics FROM exams`);
    await expectDenied(db, sql`SELECT answer_keys FROM exams`);
    await expectDenied(db, sql`SELECT * FROM exams`);
    await expectDenied(db, sql`SELECT password_hash FROM admins`);
    for (const table of ['grade_items', 'session_scores', 'violations', 'grading_jobs', 'client_events']) {
      await expectDenied(db, sql.raw(`SELECT * FROM ${table}`));
    }
  });

  it('시험 종료 시각을 늘리거나 시험 상태를 바꿀 수 없다', async () => {
    const db = server.roles.candidateServer;
    await expectDenied(db, sql`UPDATE exam_sessions SET expires_at = expires_at + interval '1 hour'`);
    await expectDenied(db, sql`UPDATE exams SET status = 'open'`);
    await expectDenied(db, sql`UPDATE candidates SET pin_hash = 'x'`);
  });
});

describe('관리자 서버 DB 역할', () => {
  it('루브릭·정답을 읽을 수 없다(등록할 때 쓰기만 한다)', async () => {
    const db = server.roles.adminServer;
    await expectDenied(db, sql`SELECT rubrics FROM exams`);
    await expectDenied(db, sql`SELECT answer_keys FROM exams`);
  });

  it('응시자 PIN 해시를 읽을 수 없다(발급할 때 쓰기만 한다)', async () => {
    const db = server.roles.adminServer;
    await expectDenied(db, sql`SELECT pin_hash FROM candidates`);
    await expectDenied(db, sql`SELECT * FROM candidates`);
    expect((await db.select({ candidateNo: tables.candidates.candidateNo }).from(tables.candidates)).length).toBe(1);
  });

  it('응시 기록(대화·답안)을 대신 쓰거나 세션을 끝낼 수 없고 관리자 계정을 만들 수 없다', async () => {
    const db = server.roles.adminServer;
    await expectDenied(db, sql`INSERT INTO answers (exam_session_id, subquestion_key, version, content, is_final, source, saved_at) SELECT id, '1-2', 99, '{"kind":"text","text":"대리 작성"}'::jsonb, true, 'manual', now() FROM exam_sessions`);
    await expectDenied(db, sql`INSERT INTO messages (conversation_id, exam_session_id, seq, role, content, plain_text, provider, model, status) SELECT id, exam_session_id, 99, 'user', '[]', 'x', 'mock', 'm', 'complete' FROM conversations`);
    await expectDenied(db, sql`UPDATE exam_sessions SET status = 'submitted'`);
    await expectDenied(db, sql`INSERT INTO admins (username, password_hash) VALUES ('intruder', 'x')`);
    await expectDenied(db, sql`INSERT INTO session_scores (grading_job_id, exam_session_id) SELECT id, id FROM exam_sessions`);
  });
});

describe('채점 워커 DB 역할', () => {
  it('루브릭·정답은 읽지만 응시 기록과 토큰 원장은 쓸 수 없다', async () => {
    const db = server.roles.gradingWorker;
    const rows = await db.select({ rubrics: tables.exams.rubrics, answerKeys: tables.exams.answerKeys }).from(tables.exams);
    expect(Object.keys(rows[0]!.rubrics).length).toBeGreaterThan(0);
    await expectDenied(db, sql`INSERT INTO token_ledger (exam_session_id, delta, balance_after, reason, actor) SELECT id, 1000, 1000, 'refund', 'x' FROM exam_sessions`);
    await expectDenied(db, sql`UPDATE exam_sessions SET expires_at = now()`);
    await expectDenied(db, sql`SELECT * FROM auth_sessions`);
    await expectDenied(db, sql`SELECT * FROM admins`);
    await expectDenied(db, sql`SELECT pin_hash FROM candidates`);
  });
});

describe('추가만 하는 기록', () => {
  it('어느 서버 역할도 대화·토큰 원장·답안·감사 로그를 고치거나 지울 수 없다', async () => {
    for (const db of Object.values(server.roles)) {
      for (const table of APPEND_ONLY_TABLES) {
        await expectDenied(db, sql.raw(`UPDATE ${table} SET id = id`));
        await expectDenied(db, sql.raw(`DELETE FROM ${table}`));
        await expectDenied(db, sql.raw(`TRUNCATE ${table}`));
      }
    }
    // 준비 단계에서 만든 기록이 그대로 남아 있다
    expect((await server.db.select().from(tables.messages)).length).toBeGreaterThanOrEqual(2);
    expect((await server.db.select().from(tables.answers)).length).toBe(1);
  });
});

describe('다중 인스턴스 조정 테이블', () => {
  it('응답 진행·요청 한도 기록은 수험생 서버만 다룬다', async () => {
    for (const db of [server.roles.adminServer, server.roles.gradingWorker]) {
      await expectDenied(db, sql`SELECT * FROM ai_streams`);
      await expectDenied(db, sql`SELECT * FROM rate_limit_hits`);
      await expectDenied(db, sql`DELETE FROM rate_limit_hits`);
    }
    // 수험생 서버는 조정용 임시 상태를 지울 수 있다(기록 테이블과 다르다)
    await server.roles.candidateServer.execute(sql`DELETE FROM rate_limit_hits WHERE bucket = 'none'`);
  });
});

describe('서버 분리', () => {
  it('수험생 서버에는 관리자 API가 없고 관리자 서버에는 응시 API가 없다', async () => {
    const adminLogin = await server.apps.candidate.request('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(adminLogin.status).toBe(404);
    const candidateLogin = await server.apps.admin.request('/api/candidate/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(candidateLogin.status).toBe(404);
    expect((await server.apps.admin.request('/api/candidate/state')).status).toBe(404);
  });
});
