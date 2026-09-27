import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface ListenConfig {
  /** 이 주소로만 연결을 받는다. 관리자 서버는 127.0.0.1처럼 운영 PC로 좁힐 수 있다 */
  host: string;
  port: number;
}

export interface LoginPolicy {
  cookieSecure: boolean;
  authSessionHours: number;
  maxFailures: number;
  lockMinutes: number;
  attemptsPerIpPerMinute: number;
}

/** 두 서버가 함께 쓰는 로그인 정책 환경변수 */
export const loginPolicyEnvShape = {
  COOKIE_SECURE: z.enum(['true', 'false']),
  AUTH_SESSION_HOURS: z.coerce.number().int().min(1).max(72),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1),
  LOGIN_ATTEMPTS_PER_IP_PER_MINUTE: z.coerce.number().int().min(1),
};

export function loginPolicyFrom(e: z.infer<z.ZodObject<typeof loginPolicyEnvShape>>): LoginPolicy {
  return {
    cookieSecure: e.COOKIE_SECURE === 'true',
    authSessionHours: e.AUTH_SESSION_HOURS,
    maxFailures: e.LOGIN_MAX_FAILURES,
    lockMinutes: e.LOGIN_LOCK_MINUTES,
    attemptsPerIpPerMinute: e.LOGIN_ATTEMPTS_PER_IP_PER_MINUTE,
  };
}

export const hostSchema = z.string().min(1);

/** 쿠키 이름(RFC 6265 토큰). Firebase Hosting 뒤에서는 Cloud Run으로 넘어가는 유일한 이름인 __session을 쓴다 */
export const cookieNameSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/u, '영문·숫자·밑줄 쿠키 이름입니다');

/**
 * 같은 출처 검사에서 요청 주소로 볼 헤더. 직접 받으면 host, Firebase Hosting처럼 앞단이 Host를 바꿔 넘기면
 * 원래 주소를 담은 x-forwarded-host(2026-09-27 배포 결정)
 */
export const requestHostHeaderSchema = z.enum(['host', 'x-forwarded-host']);
export type RequestHostHeader = z.infer<typeof requestHostHeaderSchema>;
export const portSchema = z.coerce.number().int().min(1).max(65535);

/** 스키마로 환경변수를 검증하고, 실패하면 빠진 항목을 모두 적은 오류를 던진다 */
export function parseEnv<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv, label: string): T {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`${label} 환경변수가 올바르지 않습니다. infra/.env.example을 참고하십시오.\n${lines.join('\n')}`);
  }
  return parsed.data;
}
