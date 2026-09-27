import {
  candidateLoginRequestSchema,
  clientEventRequestSchema,
  type ConversationProgressResponse,
  keySchema,
  saveAnswerRequestSchema,
  sendMessageRequestSchema,
} from '@ai-measurement/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { appErrors } from '../lib/app-error';
import { ok, readJsonBody } from '../lib/json-body';
import { actorOf } from '../modules/audit/audit-log';
import { clearAuthCookie, requireCandidate, setAuthCookie, type CandidateEnv } from '../modules/auth/auth-http';
import type { CandidateServices } from '../candidate-services';
import { chatStreamResponse } from './chat-stream-route';
import { clientAddress } from './client-address';

const caseBodySchema = z.strictObject({ caseKey: keySchema });

function param(value: string | undefined, name: string): string {
  if (value === undefined || !keySchema.safeParse(value).success) throw appErrors.badRequest('invalid_path', `${name} 형식이 올바르지 않습니다`);
  return value;
}

function uuidParam(value: string | undefined): string {
  if (value === undefined || !z.uuid().safeParse(value).success) throw appErrors.badRequest('invalid_path', '식별자 형식이 올바르지 않습니다');
  return value;
}

/** 응시자 API(/api/candidate) */
export function candidateRoutes(s: CandidateServices): Hono<CandidateEnv> {
  const cookiePolicy = { secure: s.config.login.cookieSecure };
  const cookieName = s.config.sessionCookie;
  const app = new Hono<CandidateEnv>();

  app.post('/login', async (c) => {
    const body = await readJsonBody(c, candidateLoginRequestSchema);
    const result = await s.auth.login(body.candidateNo, body.pin, clientAddress(c));
    setAuthCookie(c, cookieName, result.token, result.expiresAt, cookiePolicy);
    return ok(c, { candidateNo: result.principal.candidateNo });
  });

  const authed = new Hono<CandidateEnv>();
  authed.use(requireCandidate(s.auth, cookieName));

  authed.post('/logout', async (c) => {
    await s.auth.logout(c.get('candidate').authSessionId);
    clearAuthCookie(c, cookieName, cookiePolicy);
    return ok(c, {});
  });

  authed.get('/state', async (c) => ok(c, await s.candidateState.getState(c.get('candidate'))));

  authed.post('/session/start', async (c) => {
    await s.sessions.start(c.get('candidate'));
    return ok(c, await s.candidateState.getState(c.get('candidate')), 201);
  });

  authed.post('/session/submit', async (c) => {
    const principal = c.get('candidate');
    const session = await s.sessions.requireWritable(principal.candidateId);
    await s.sessions.end(session.id, 'submitted', actorOf.candidate(principal.candidateId));
    return ok(c, await s.candidateState.getState(principal));
  });

  authed.post('/events', async (c) => {
    await s.candidateState.recordClientEvent(c.get('candidate'), await readJsonBody(c, clientEventRequestSchema));
    return ok(c, {});
  });

  authed.put('/answers/:subquestionKey', async (c) => {
    const body = await readJsonBody(c, saveAnswerRequestSchema);
    return ok(c, await s.answers.save(c.get('candidate'), param(c.req.param('subquestionKey'), '하위문항'), body.content, false));
  });

  authed.post('/answers/:subquestionKey/submit', async (c) => {
    const body = await readJsonBody(c, saveAnswerRequestSchema);
    return ok(c, await s.answers.save(c.get('candidate'), param(c.req.param('subquestionKey'), '하위문항'), body.content, true));
  });

  authed.get('/cases/:caseKey/materials/:materialKey/preview', async (c) => {
    const { exam } = await startedExam(s, c.get('candidate').candidateId);
    return ok(c, await s.materials.preview(exam, param(c.req.param('caseKey'), 'Case'), param(c.req.param('materialKey'), '자료')));
  });

  authed.get('/cases/:caseKey/materials/:materialKey/file', async (c) => {
    const { exam } = await startedExam(s, c.get('candidate').candidateId);
    const file = await s.materials.download(exam, param(c.req.param('caseKey'), 'Case'), param(c.req.param('materialKey'), '자료'));
    const disposition = file.contentType.startsWith('application/pdf') ? 'inline' : 'attachment';
    return c.body(new Uint8Array(file.bytes), 200, {
      'content-type': file.contentType,
      'content-disposition': `${disposition}; filename="${encodeURIComponent(file.fileName)}"`,
      'cache-control': 'private, no-store',
    });
  });

  authed.post('/conversations', async (c) => {
    const body = await readJsonBody(c, caseBodySchema);
    return ok(c, await s.chat.createConversation(c.get('candidate'), body.caseKey), 201);
  });

  authed.get('/conversations/:conversationId', async (c) =>
    ok(c, await s.chat.getConversation(c.get('candidate'), uuidParam(c.req.param('conversationId')))),
  );

  authed.post('/conversations/:conversationId/messages', async (c) => {
    const body = await readJsonBody(c, sendMessageRequestSchema);
    return ok(c, await s.chat.sendMessage(c.get('candidate'), uuidParam(c.req.param('conversationId')), body), 201);
  });

  authed.get('/conversations/:conversationId/progress', async (c) => {
    const conversationId = uuidParam(c.req.param('conversationId'));
    await s.chat.ownedConversation(c.get('candidate'), conversationId);
    const text = await s.hub.progress(conversationId);
    const body: ConversationProgressResponse = { streaming: text !== null, text };
    return ok(c, body);
  });

  /** SSE로 이어 받기. 화면은 /progress를 쓰고, 이 경로는 API 사용자·부하 테스트용으로 남긴다 */
  authed.get('/conversations/:conversationId/stream', async (c) => {
    const conversationId = uuidParam(c.req.param('conversationId'));
    await s.chat.ownedConversation(c.get('candidate'), conversationId);
    return chatStreamResponse(c, s.hub, conversationId);
  });

  app.route('/', authed);
  return app;
}

/** 자료는 시험을 시작한 응시자에게만 준다 */
async function startedExam(s: CandidateServices, candidateId: string) {
  const session = await s.sessions.findByCandidate(candidateId);
  if (session === null) throw appErrors.forbidden('session_not_started', '시험을 시작한 뒤에 자료를 볼 수 있습니다');
  return { session, exam: await s.catalog.get(session.examId) };
}
