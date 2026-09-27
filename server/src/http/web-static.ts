import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import { appErrors } from '../lib/app-error';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
};

export interface WebStaticOptions {
  /** 빌드 결과 폴더(web/dist/candidate 또는 web/dist/admin) */
  rootDir: string;
  /** 파일이 없는 경로에 돌려줄 SPA 진입 HTML(빌드 폴더 기준 상대 경로) */
  indexFile: string;
}

/** 빌드 결과에서 해시가 붙은 파일이 들어가는 폴더(오래 캐시해도 되는 파일) */
const HASHED_ASSET_DIR = 'assets';

/**
 * 빌드된 웹을 제공한다. /api 밖의 GET 요청 중 확장자가 없는 경로(화면 주소)에는 진입 HTML을 준다(SPA 라우팅).
 * 확장자가 있는데 파일이 없으면 404다. 요청 경로는 루트 밖으로 나가지 못하게 막는다.
 */
export function mountWebStatic(app: Hono, options: WebStaticOptions): void {
  const root = path.resolve(options.rootDir);
  const indexPath = path.join(root, options.indexFile);
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    let decoded: string;
    try {
      decoded = decodeURIComponent(c.req.path);
    } catch {
      // 깨진 퍼센트 인코딩(예: /%)은 서버 오류가 아니라 잘못된 요청이다
      throw appErrors.badRequest('invalid_path', '주소 형식이 올바르지 않습니다');
    }
    const requested = path.resolve(root, `.${decoded}`);
    const inside = requested === root || requested.startsWith(`${root}${path.sep}`);
    const extension = path.extname(requested);
    const target = inside && extension !== '' && CONTENT_TYPES[extension] !== undefined ? requested : indexPath;
    try {
      const body = await readFile(target);
      const type = CONTENT_TYPES[path.extname(target)];
      if (type === undefined) return c.notFound();
      // 루트 기준 경로로 판단한다. 빌드 폴더 위쪽 경로에 assets라는 폴더가 있어도 진입 HTML을 오래 캐시하지 않는다
      const immutable = path.relative(root, target).split(path.sep)[0] === HASHED_ASSET_DIR;
      return c.body(body, 200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    } catch {
      return c.notFound();
    }
  });
}
