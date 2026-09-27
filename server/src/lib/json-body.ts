import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError, appErrors } from './app-error';

/** JSON 본문을 읽고 스키마로 검증한다. 실패하면 400 */
export async function readJsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw appErrors.badRequest('invalid_json', '요청 본문이 JSON이 아닙니다');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw appErrors.badRequest(
      'invalid_request',
      parsed.error.issues[0]?.message ?? '요청 형식이 올바르지 않습니다',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  return c.json({ ok: true, data }, status);
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
