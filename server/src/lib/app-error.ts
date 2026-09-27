import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * 응답으로 그대로 내보내도 되는 오류. code는 클라이언트가 분기에 쓰는 고정 문자열이고,
 * message는 사용자에게 보여줄 한국어 문장이다. 내부 정보(스택, SQL)는 넣지 않는다.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const appErrors = {
  badRequest: (code: string, message: string, details?: unknown) => new AppError(400, code, message, details),
  unauthorized: (message = '로그인이 필요합니다') => new AppError(401, 'unauthorized', message),
  forbidden: (code: string, message: string) => new AppError(403, code, message),
  notFound: (code: string, message: string) => new AppError(404, code, message),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  gone: (code: string, message: string) => new AppError(410, code, message),
  payloadTooLarge: (message: string) => new AppError(413, 'payload_too_large', message),
  unprocessable: (code: string, message: string, details?: unknown) => new AppError(422, code, message, details),
  tooManyRequests: (code: string, message: string) => new AppError(429, code, message),
  upstream: (code: string, message: string, details?: unknown) => new AppError(502, code, message, details),
};
