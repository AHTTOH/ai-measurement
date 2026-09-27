import type { Hono } from 'hono';
import type { CandidateServices } from './candidate-services';
import { buildAppShell } from './http/app-shell';
import { candidateRoutes } from './http/candidate-routes';

/** 수험생 SPA 진입 HTML(web/index.html을 빌드한 결과) */
export const CANDIDATE_WEB_INDEX = 'index.html';

/** 수험생 서버 앱. /api/candidate만 있고 관리자 API는 없다 */
export function buildCandidateApp(s: CandidateServices): Hono {
  return buildAppShell(
    { logger: s.logger, requestHostHeader: s.config.requestHostHeader, rawBodyPaths: [], web: s.config.webDistDir !== null ? { rootDir: s.config.webDistDir, indexFile: CANDIDATE_WEB_INDEX } : null },
    (app) => {
      app.route('/api/candidate', candidateRoutes(s));
    },
  );
}
