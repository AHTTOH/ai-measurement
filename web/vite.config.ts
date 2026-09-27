import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');

/**
 * 수험생 웹과 관리자 웹은 따로 빌드한다(결정: 2026-09-27 권한 구조 분리).
 * 각 빌드에는 자기 화면 코드만 들어가고, 각 서버가 자기 빌드만 제공한다.
 */
const SURFACES = {
  candidate: { entryHtml: 'index.html', outDir: 'dist/candidate', apiOriginVariable: 'WEB_DEV_CANDIDATE_API_ORIGIN', apiPrefix: '/api/candidate' },
  admin: { entryHtml: 'admin.html', outDir: 'dist/admin', apiOriginVariable: 'WEB_DEV_ADMIN_API_ORIGIN', apiPrefix: '/api/admin' },
} as const;

type SurfaceName = keyof typeof SURFACES;

function isSurface(mode: string): mode is SurfaceName {
  return Object.hasOwn(SURFACES, mode);
}

/** 개발 서버에서 화면 경로(HTML 요청)를 관리자 진입 HTML로 돌린다. 수험생은 Vite 기본값(index.html)을 쓴다 */
function spaEntryFallback(entryHtml: string): Plugin {
  return {
    name: 'spa-entry-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const accept = req.headers.accept ?? '';
        const url = req.url ?? '';
        if (req.method === 'GET' && accept.includes('text/html') && !url.startsWith('/api/') && path.extname(url.split('?')[0] ?? '') === '') {
          req.url = `/${entryHtml}`;
        }
        next();
      });
    },
  };
}

/**
 * 실행: vite --mode candidate | vite --mode admin (build도 같다).
 * 개발 서버는 자기 API만 해당 서버로 넘긴다. 대상 주소는 저장소 루트 .env에서 읽는다.
 * Host 헤더를 바꾸지 않아(changeOrigin: false) 서버의 같은 출처 검사가 브라우저 주소 기준으로 동작한다.
 */
export default defineConfig(({ command, mode }) => {
  if (!isSurface(mode)) throw new Error(`--mode는 ${Object.keys(SURFACES).join(' 또는 ')}여야 합니다: ${mode}`);
  const surface = SURFACES[mode];
  const env = loadEnv(mode, repoRoot, '');
  const apiOrigin = env[surface.apiOriginVariable];
  if (command === 'serve' && (apiOrigin === undefined || apiOrigin === '')) {
    throw new Error(`${surface.apiOriginVariable}가 없습니다. 저장소 루트 .env에 적으십시오(infra/.env.example 참고)`);
  }
  return {
    plugins: [react(), ...(mode === 'admin' ? [spaEntryFallback(surface.entryHtml)] : [])],
    server: apiOrigin ? { proxy: { [surface.apiPrefix]: { target: apiOrigin, changeOrigin: false } } } : {},
    build: {
      outDir: surface.outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: path.join(webRoot, surface.entryHtml) },
    },
  };
});
