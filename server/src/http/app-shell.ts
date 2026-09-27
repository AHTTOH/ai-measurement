import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppError, appErrors } from '../lib/app-error';
import type { RequestHostHeader } from '../config/common-config';
import type { Logger } from '../lib/logger';
import { sameOriginGuard, securityHeaders } from './security-middleware';
import { mountWebStatic, type WebStaticOptions } from './web-static';

/** JSON 요청 본문 한도. 메시지 본문 최대 글자 수(MAX_MESSAGE_CHARS)를 담을 수 있는 크기 */
const JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;

export interface AppShellOptions {
  logger: Logger;
  /** 같은 출처 검사에서 요청 주소로 볼 헤더 */
  requestHostHeader: RequestHostHeader;
  /** JSON 본문 한도를 적용하지 않는 경로(자체 한도를 따로 거는 업로드 경로) */
  rawBodyPaths: readonly string[];
  /** 빌드된 웹을 함께 제공할 때 설정. null이면 API만 제공 */
  web: WebStaticOptions | null;
}

/**
 * 두 서버가 같은 틀을 쓴다: 보안 헤더, 같은 출처 검사, 본문 한도, 오류 응답 형식.
 * register 안에서 각 서버가 자기 API만 붙인다. 웹 정적 파일은 API 뒤에 붙는다.
 */
export function buildAppShell(options: AppShellOptions, register: (app: Hono) => void): Hono {
  const app = new Hono();
  const jsonLimit = bodyLimit({
    maxSize: JSON_BODY_MAX_BYTES,
    onError: () => {
      throw appErrors.payloadTooLarge('요청 본문이 너무 큽니다');
    },
  });
  const rawBodyPaths = new Set(options.rawBodyPaths);

  app.use('*', securityHeaders);
  app.use('/api/*', sameOriginGuard(options.requestHostHeader));
  app.use('/api/*', async (c, next) => (rawBodyPaths.has(c.req.path) ? next() : jsonLimit(c, next)));
  app.get('/api/health', (c) => c.json({ ok: true, data: { status: 'ok' } }));

  register(app);

  app.notFound((c) => c.json({ ok: false, error: { code: 'not_found', message: '없는 경로입니다' } }, 404));
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ ok: false, error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } }, error.status);
    }
    options.logger.error('unhandled_error', { method: c.req.method, path: c.req.path, error });
    return c.json({ ok: false, error: { code: 'internal_error', message: '서버 오류가 발생했습니다. 감독관에게 알리십시오' } }, 500);
  });

  if (options.web !== null) mountWebStatic(app, options.web);
  return app;
}
