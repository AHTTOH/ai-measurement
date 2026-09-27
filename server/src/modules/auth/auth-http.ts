import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { appErrors } from '../../lib/app-error';
import type { AdminAuthService, AdminPrincipal } from './admin-auth-service';
import type { CandidateAuthService, CandidatePrincipal } from './candidate-auth-service';

/**
 * 로그인 쿠키 이름은 설정(CANDIDATE_SESSION_COOKIE, ADMIN_SESSION_COOKIE)에서 온다.
 * 로컬처럼 두 서버가 같은 호스트의 다른 포트면 이름을 나눠야 한다(쿠키는 포트를 구분하지 않는다).
 * Firebase Hosting 뒤에서는 두 서버가 다른 도메인이고 __session만 전달되므로 둘 다 __session이다.
 */

export interface CandidateEnv {
  Variables: { candidate: CandidatePrincipal };
}

export interface AdminEnv {
  Variables: { admin: AdminPrincipal };
}

export interface CookiePolicy {
  secure: boolean;
}

export function setAuthCookie(c: Context, name: string, token: string, expiresAt: Date, policy: CookiePolicy): void {
  setCookie(c, name, token, {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'Strict',
    path: '/',
    expires: expiresAt,
  });
}

export function clearAuthCookie(c: Context, name: string, policy: CookiePolicy): void {
  deleteCookie(c, name, { path: '/', secure: policy.secure });
}

export function requireCandidate(auth: CandidateAuthService, cookieName: string): MiddlewareHandler<CandidateEnv> {
  return async (c, next) => {
    const token = getCookie(c, cookieName);
    if (token === undefined) throw appErrors.unauthorized();
    const principal = await auth.resolve(token);
    if (principal === null) throw appErrors.unauthorized('로그인이 만료되었거나 다른 곳에서 다시 로그인했습니다');
    c.set('candidate', principal);
    await next();
  };
}

export function requireAdmin(auth: AdminAuthService, cookieName: string): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const token = getCookie(c, cookieName);
    if (token === undefined) throw appErrors.unauthorized();
    const principal = await auth.resolve(token);
    if (principal === null) throw appErrors.unauthorized('관리자 로그인이 만료되었습니다');
    c.set('admin', principal);
    await next();
  };
}
