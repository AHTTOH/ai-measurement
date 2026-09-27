import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAppShell } from '../../../server/src/http/app-shell';
import { silentLogger } from '@ai-measurement/infra';

/** 2026-09-27 테스트 작성 중 발견한 웹 정적 파일 결함의 회귀 테스트 */

let baseDir = '';
let rootDir = '';

beforeAll(async () => {
  // 빌드 폴더 위쪽 경로에 'assets'라는 폴더가 있는 배치
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'aim-web-static-reg-'));
  rootDir = path.join(baseDir, 'assets', 'web');
  await mkdir(path.join(rootDir, 'assets'), { recursive: true });
  await writeFile(path.join(rootDir, 'index.html'), '<!doctype html><title>SPA</title>', 'utf8');
  await writeFile(path.join(rootDir, 'assets', 'app.js'), 'console.info("app");', 'utf8');
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function app() {
  return buildAppShell({ logger: silentLogger, requestHostHeader: 'host', rawBodyPaths: [], web: { rootDir, indexFile: 'index.html' } }, () => {});
}

describe('웹 정적 파일', () => {
  it('깨진 퍼센트 인코딩 주소는 서버 오류(500)가 아니라 잘못된 요청(400)이다', async () => {
    for (const bad of ['/%', '/bad%E0%A4']) {
      const response = await app().request(bad);
      expect(response.status, bad).toBe(400);
    }
  });

  it('빌드 폴더 위쪽 경로에 assets 폴더가 있어도 진입 HTML은 오래 캐시하지 않는다', async () => {
    const index = await app().request('/some/screen');
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const asset = await app().request('/assets/app.js');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});
