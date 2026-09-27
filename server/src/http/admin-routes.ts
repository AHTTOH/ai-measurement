import {
  adminLoginRequestSchema,
  createGradingJobRequestSchema,
  examStatusChangeRequestSchema,
  extendSessionRequestSchema,
  generateCandidatesRequestSchema,
  importDirectoryRequestSchema,
  refundRequestSchema,
} from '@ai-measurement/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { appErrors } from '../lib/app-error';
import { ok, readJsonBody } from '../lib/json-body';
import { clearAuthCookie, requireAdmin, setAuthCookie, type AdminEnv } from '../modules/auth/auth-http';
import type { AdminServices } from '../admin-services';
import { clientAddress } from './client-address';

function uuidParam(value: string | undefined): string {
  if (value === undefined || !z.uuid().safeParse(value).success) throw appErrors.badRequest('invalid_path', '식별자 형식이 올바르지 않습니다');
  return value;
}

/** 시험 zip 업로드 경로. JSON 본문 한도 대신 UPLOAD_MAX_MB 한도를 적용한다 */
export const ADMIN_ZIP_UPLOAD_PATH = '/exams/import-zip';

/** 관리자 API(/api/admin) */
export function adminRoutes(s: AdminServices): Hono<AdminEnv> {
  const cookiePolicy = { secure: s.config.login.cookieSecure };
  const cookieName = s.config.sessionCookie;
  const app = new Hono<AdminEnv>();

  app.post('/login', async (c) => {
    const body = await readJsonBody(c, adminLoginRequestSchema);
    const result = await s.auth.login(body.username, body.password, clientAddress(c));
    setAuthCookie(c, cookieName, result.token, result.expiresAt, cookiePolicy);
    return ok(c, { username: result.principal.username });
  });

  const authed = new Hono<AdminEnv>();
  authed.use(requireAdmin(s.auth, cookieName));

  authed.post('/logout', async (c) => {
    await s.auth.logout(c.get('admin').authSessionId);
    clearAuthCookie(c, cookieName, cookiePolicy);
    return ok(c, {});
  });
  authed.get('/me', (c) => ok(c, { username: c.get('admin').username }));

  authed.get('/exam-packages', async (c) => ok(c, await s.examImport.listPackages()));
  authed.post('/exams/import-directory', async (c) => {
    const body = await readJsonBody(c, importDirectoryRequestSchema);
    return ok(c, await s.examImport.importDirectory(body.slug, c.get('admin').adminId), 201);
  });
  authed.post(
    ADMIN_ZIP_UPLOAD_PATH,
    bodyLimit({ maxSize: s.config.uploadMaxBytes, onError: () => { throw appErrors.payloadTooLarge('업로드 한도를 넘는 파일입니다'); } }),
    async (c) => {
      if (c.req.header('content-type') !== 'application/zip') throw appErrors.badRequest('invalid_content_type', 'application/zip으로 보내야 합니다');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return ok(c, await s.examImport.importZip(bytes, c.get('admin').adminId), 201);
    },
  );

  authed.get('/exams', async (c) => ok(c, await s.adminResults.listExams()));
  authed.get('/exams/:examId', async (c) => ok(c, await s.adminResults.examDetail(uuidParam(c.req.param('examId')))));
  authed.post('/exams/:examId/status', async (c) => {
    const body = await readJsonBody(c, examStatusChangeRequestSchema);
    await s.examAdmin.changeStatus(uuidParam(c.req.param('examId')), body.status, c.get('admin').adminId);
    return ok(c, {});
  });
  authed.post('/exams/:examId/candidates', async (c) => {
    const body = await readJsonBody(c, generateCandidatesRequestSchema);
    return ok(c, await s.examAdmin.generateCandidates(uuidParam(c.req.param('examId')), body.prefix, body.count, c.get('admin').adminId), 201);
  });
  authed.post('/exams/:examId/grading-jobs', async (c) => {
    const body = await readJsonBody(c, createGradingJobRequestSchema);
    return ok(c, await s.gradingJobs.create(uuidParam(c.req.param('examId')), body.llmMode, c.get('admin').adminId), 201);
  });
  authed.get('/exams/:examId/scores.csv', async (c) => {
    const examId = uuidParam(c.req.param('examId'));
    const exam = await s.catalog.get(examId);
    return c.body(await s.adminResults.scoresCsv(examId), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exam.slug}-scores.csv"`,
      'cache-control': 'no-store',
    });
  });

  authed.get('/sessions/:sessionId', async (c) => ok(c, await s.sessionDetail.detail(uuidParam(c.req.param('sessionId')))));
  authed.get('/sessions/:sessionId/export.json', async (c) => {
    const detail = await s.sessionDetail.detail(uuidParam(c.req.param('sessionId')));
    return c.body(JSON.stringify(detail, null, 2), 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${detail.candidateNo}-session.json"`,
      'cache-control': 'no-store',
    });
  });
  authed.post('/sessions/:sessionId/extend', async (c) => {
    const body = await readJsonBody(c, extendSessionRequestSchema);
    const expiresAt = await s.sessionExtension.extend(uuidParam(c.req.param('sessionId')), body.minutes, body.reason, c.get('admin').adminId);
    return ok(c, { expiresAt: expiresAt.toISOString() });
  });
  authed.post('/sessions/:sessionId/refund', async (c) => {
    const body = await readJsonBody(c, refundRequestSchema);
    const balance = await s.ledger.refund(uuidParam(c.req.param('sessionId')), body.messageId, body.reason, c.get('admin').adminId);
    return ok(c, { tokenBalance: balance });
  });

  app.route('/', authed);
  return app;
}
