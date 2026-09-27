import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, appErrors } from '../../../server/src/lib/app-error';
import { isAppError, ok, readJsonBody } from '../../../server/src/lib/json-body';

const noteSchema = z.object({
  title: z.string().min(1, '제목을 적으십시오'),
  count: z.number().int('정수를 적으십시오'),
});

/** readJsonBody가 던진 AppError를 app-shell과 같은 형식으로 응답에 옮긴다 */
function buildApp(): Hono {
  const app = new Hono();
  app.post('/notes', async (c) => ok(c, await readJsonBody(c, noteSchema)));
  app.post('/notes/created', async (c) => ok(c, await readJsonBody(c, noteSchema), 201));
  app.onError((error, c) => {
    if (!isAppError(error)) return c.json({ ok: false, error: { code: 'unexpected' } }, 500);
    return c.json({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, error.status);
  });
  return app;
}

function postJson(app: Hono, path: string, body: string): Promise<Response> {
  return Promise.resolve(app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
}

describe('JSON 본문 읽기', () => {
  it('스키마에 맞는 본문은 검증된 값으로 돌려주고 ok 형식(200)으로 응답한다', async () => {
    // Act
    const response = await postJson(buildApp(), '/notes', JSON.stringify({ title: '메모', count: 3 }));

    // Assert
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { title: '메모', count: 3 } });
  });

  it('ok에 201을 주면 생성 응답 코드로 보낸다', async () => {
    const response = await postJson(buildApp(), '/notes/created', JSON.stringify({ title: '새 메모', count: 1 }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: { title: '새 메모', count: 1 } });
  });

  it.each([
    ['깨진 JSON', '{"title":'],
    ['빈 본문', ''],
  ])('%s는 400 invalid_json으로 거부한다', async (_label, body) => {
    const response = await postJson(buildApp(), '/notes', body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_json', message: '요청 본문이 JSON이 아닙니다' } });
  });

  it('스키마에 어긋나면 400 invalid_request로 첫 문제를 메시지로, 모든 문제를 details로 준다', async () => {
    // Act
    const response = await postJson(buildApp(), '/notes', JSON.stringify({ title: '', count: 1.5 }));

    // Assert
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: '제목을 적으십시오',
        details: [
          { path: 'title', message: '제목을 적으십시오' },
          { path: 'count', message: '정수를 적으십시오' },
        ],
      },
    });
  });

  it('JSON 배열처럼 형식이 전혀 다른 본문도 invalid_request로 거부한다', async () => {
    const response = await postJson(buildApp(), '/notes', '[1,2,3]');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});

describe('AppError 판별', () => {
  it('AppError와 그 생성 함수가 만든 오류만 true다', () => {
    expect(isAppError(new AppError(409, 'conflict', '충돌'))).toBe(true);
    expect(isAppError(appErrors.badRequest('bad', '잘못된 요청'))).toBe(true);
    expect(isAppError(new Error('일반 오류'))).toBe(false);
    expect(isAppError({ status: 400, code: 'bad', message: '흉내' })).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
