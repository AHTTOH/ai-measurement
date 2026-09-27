import type { MiddlewareHandler } from "hono";
import type { RequestHostHeader } from "../config/common-config";
import { secureHeaders } from "hono/secure-headers";
import { appErrors } from "../lib/app-error";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 상태를 바꾸는 요청은 같은 출처에서 온 것만 받는다(CSRF 방어).
 * 쿠키는 SameSite=Strict이지만, 브라우저가 보내는 Origin·Sec-Fetch-Site도 확인한다.
 */
export function sameOriginGuard(
  hostHeader: RequestHostHeader,
): MiddlewareHandler {
  return async (c, next) => {
    if (STATE_CHANGING_METHODS.has(c.req.method)) {
      const fetchSite = c.req.header("sec-fetch-site");
      if (
        fetchSite !== undefined &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none"
      ) {
        throw appErrors.forbidden(
          "cross_origin_blocked",
          "다른 사이트에서 보낸 요청은 받지 않습니다",
        );
      }
      const origin = c.req.header("origin");
      const host = c.req.header(hostHeader);
      if (
        origin !== undefined &&
        host !== undefined &&
        new URL(origin).host !== host
      ) {
        throw appErrors.forbidden(
          "cross_origin_blocked",
          "다른 사이트에서 보낸 요청은 받지 않습니다",
        );
      }
    }
    await next();
  };
}

/** 보안 헤더. PDF 미리보기를 같은 출처 iframe으로 띄우므로 frame-src 'self'를 허용한다 */
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    frameSrc: ["'self'"],
    frameAncestors: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
  xFrameOptions: "SAMEORIGIN",
  referrerPolicy: "strict-origin-when-cross-origin",
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
});
