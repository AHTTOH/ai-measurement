import type { Hono } from 'hono';
import type { AdminServices } from './admin-services';
import { ADMIN_ZIP_UPLOAD_PATH, adminRoutes } from './http/admin-routes';
import { buildAppShell } from './http/app-shell';

/** 관리자 SPA 진입 HTML(web/admin.html을 빌드한 결과) */
export const ADMIN_WEB_INDEX = 'admin.html';
const ADMIN_API_PREFIX = '/api/admin';

/** 관리자 서버 앱. /api/admin만 있고 응시 API는 없다 */
export function buildAdminApp(s: AdminServices): Hono {
  return buildAppShell(
    {
      logger: s.logger,
      requestHostHeader: s.config.requestHostHeader,
      rawBodyPaths: [`${ADMIN_API_PREFIX}${ADMIN_ZIP_UPLOAD_PATH}`],
      web: s.config.webDistDir !== null ? { rootDir: s.config.webDistDir, indexFile: ADMIN_WEB_INDEX } : null,
    },
    (app) => {
      app.route(ADMIN_API_PREFIX, adminRoutes(s));
    },
  );
}
