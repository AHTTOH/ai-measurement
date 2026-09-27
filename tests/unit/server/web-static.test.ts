import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountWebStatic } from '../../../server/src/http/web-static';

/**
 * 임시 폴더 구조:
 *   <base>/web/index.html, <base>/web/assets/app.js, <base>/web/notes.txt, <base>/web/index.txt
 *   <base>/secret.js            루트 밖 파일(새어 나가면 안 된다)
 *   <base>/web-evil/app.js      루트 이름으로 시작하는 형제 폴더(접두어 비교 함정)
 */
const INDEX_HTML = '<!doctype html><title>SPA</title>';
const APP_JS = 'console.info("app");';
const SECRET = 'SECRET-OUTSIDE-ROOT';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

let baseDir = '';
let rootDir = '';

beforeAll(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'aim-web-static-'));
  rootDir = path.join(baseDir, 'web');
  await mkdir(path.join(rootDir, 'assets'), { recursive: true });
  await mkdir(path.join(baseDir, 'web-evil'), { recursive: true });
  await writeFile(path.join(rootDir, 'index.html'), INDEX_HTML, 'utf8');
  await writeFile(path.join(rootDir, 'assets', 'app.js'), APP_JS, 'utf8');
  await writeFile(path.join(rootDir, 'notes.txt'), 'plain text note', 'utf8');
  await writeFile(path.join(rootDir, 'index.txt'), 'index in unsupported type', 'utf8');
  await writeFile(path.join(baseDir, 'secret.js'), SECRET, 'utf8');
  await writeFile(path.join(baseDir, 'web-evil', 'app.js'), SECRET, 'utf8');
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function appWith(indexFile: string): Hono {
  const app = new Hono();
  mountWebStatic(app, { rootDir, indexFile });
  return app;
}

async function get(app: Hono, requestPath: string): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await app.request(requestPath);
  return { status: response.status, body: await response.text(), headers: response.headers };
}

describe('빌드된 웹 정적 제공: 파일과 SPA 진입', () => {
  it('assets 아래 파일은 형식에 맞는 content-type과 영구 캐시로 준다', async () => {
    // Act
    const response = await get(appWith('index.html'), '/assets/app.js');

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toBe(APP_JS);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_CACHE);
  });

  it('루트 경로는 진입 HTML을 no-cache로 준다', async () => {
    const response = await get(appWith('index.html'), '/');

    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('확장자 없는 화면 경로는 진입 HTML로 돌린다(SPA 라우팅)', async () => {
    const response = await get(appWith('index.html'), '/exam/case-1/subquestion');

    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  it('지원하지 않는 확장자 파일은 내용을 주지 않고 진입 HTML로 돌린다', async () => {
    const response = await get(appWith('index.html'), '/notes.txt');

    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  it('지원 확장자인데 파일이 없으면 HTML 대신 404를 준다', async () => {
    const response = await get(appWith('index.html'), '/assets/missing.js');

    expect(response.status).toBe(404);
    expect(response.body).not.toContain('SPA');
  });

  it('/api/ 경로는 파일을 찾지 않고 404를 준다', async () => {
    const response = await get(appWith('index.html'), '/api/unknown');

    expect(response.status).toBe(404);
    expect(response.body).not.toBe(INDEX_HTML);
  });
});

describe('빌드된 웹 정적 제공: 루트 밖 접근 차단', () => {
  it.each([
    ['인코딩한 슬래시로 상위 폴더', '/..%2fsecret.js'],
    ['인코딩한 점과 슬래시로 상위 폴더', '/%2e%2e%2fsecret.js'],
    ['대문자 인코딩', '/%2E%2E%2Fsecret.js'],
    ['중첩 경로에서 두 단계 위로', '/assets%2f..%2f..%2fsecret.js'],
    ['루트 이름으로 시작하는 형제 폴더', '/..%2fweb-evil%2fapp.js'],
  ])('%s(%s)는 루트 밖 파일을 주지 않고 진입 HTML로 돌린다', async (_label, requestPath) => {
    // Act
    const response = await get(appWith('index.html'), requestPath);

    // Assert
    expect(response.body).not.toContain(SECRET);
    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  it('인코딩한 역슬래시로도 루트 밖 파일을 주지 않는다(Windows는 구분자, POSIX는 파일 이름 글자)', async () => {
    const response = await get(appWith('index.html'), '/..%5csecret.js');

    expect(response.body).not.toContain(SECRET);
  });

  it('인코딩하지 않은 ..는 URL 정규화로 루트 안 경로가 되어 없는 파일(404)이 된다', async () => {
    const response = await get(appWith('index.html'), '/../secret.js');

    expect(response.body).not.toContain(SECRET);
    expect(response.status).toBe(404);
  });

  it('두 번 인코딩한 점은 한 번만 풀려 루트 밖으로 나가지 못한다', async () => {
    const response = await get(appWith('index.html'), '/%252e%252e%252fsecret.js');

    expect(response.body).not.toContain(SECRET);
    expect(response.status).toBe(404);
  });
});

describe('빌드된 웹 정적 제공: 진입 파일 설정', () => {
  it('진입 파일이 없으면 404를 준다', async () => {
    const response = await get(appWith('missing-index.html'), '/exam');

    expect(response.status).toBe(404);
  });

  it('진입 파일이 지원하지 않는 형식이면 내용을 주지 않고 404를 준다', async () => {
    const response = await get(appWith('index.txt'), '/exam');

    expect(response.status).toBe(404);
    expect(response.body).not.toContain('index in unsupported type');
  });
});
