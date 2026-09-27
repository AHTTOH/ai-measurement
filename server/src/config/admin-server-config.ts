import path from 'node:path';
import { databaseConnectionFromEnv, type DatabaseConnection } from '@ai-measurement/infra';
import { z } from 'zod';
import { cookieNameSchema, hostSchema, loginPolicyEnvShape, requestHostHeaderSchema, type RequestHostHeader, loginPolicyFrom, parseEnv, portSchema, type ListenConfig, type LoginPolicy } from './common-config';

/**
 * 관리자 서버 환경변수. 모두 필수이며 코드 쪽 기본값이 없다(폴백 금지). 뜻은 infra/.env.example.
 * 관리자 서버는 AI를 호출하지 않으므로 API 키를 받지 않는다.
 */
const adminEnvSchema = z.object({
  ADMIN_SERVER_HOST: hostSchema,
  ADMIN_SERVER_PORT: portSchema,
  ADMIN_SESSION_COOKIE: cookieNameSchema,
  REQUEST_HOST_HEADER: requestHostHeaderSchema,
  ADMIN_SERVER_DB_MAX_CONNECTIONS: z.coerce.number().int().min(1),
  ADMIN_WEB_DIST_DIR: z.string().min(1).optional(),
  EXAMS_DIR: z.string().min(1),
  /** 채점 작업에 기록할 LLM 공급자. 채점 워커 설정과 같아야 작업이 돈다 */
  GRADING_LLM_PROVIDER: z.enum(['anthropic', 'mock']),
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(500),
  ...loginPolicyEnvShape,
});

export interface AdminServerConfig {
  database: DatabaseConnection;
  databaseMaxConnections: number;
  listen: ListenConfig;
  examsDir: string;
  gradingLlmProvider: 'anthropic' | 'mock';
  uploadMaxBytes: number;
  login: LoginPolicy;
  /** 로그인 쿠키 이름 */
  sessionCookie: string;
  /** 같은 출처 검사에서 요청 주소로 볼 헤더 */
  requestHostHeader: RequestHostHeader;
  /** 빌드된 관리자 웹(web/dist/admin)을 함께 제공할 때 경로. 없으면 API만 제공 */
  webDistDir: string | null;
}

export function loadAdminServerConfig(env: NodeJS.ProcessEnv): AdminServerConfig {
  const e = parseEnv(adminEnvSchema, env, '관리자 서버');
  return {
    database: databaseConnectionFromEnv(env, 'ADMIN_SERVER_DB_USER', 'ADMIN_SERVER_DB_PASSWORD'),
    databaseMaxConnections: e.ADMIN_SERVER_DB_MAX_CONNECTIONS,
    listen: { host: e.ADMIN_SERVER_HOST, port: e.ADMIN_SERVER_PORT },
    examsDir: path.resolve(e.EXAMS_DIR),
    gradingLlmProvider: e.GRADING_LLM_PROVIDER,
    uploadMaxBytes: e.UPLOAD_MAX_MB * 1024 * 1024,
    login: loginPolicyFrom(e),
    sessionCookie: e.ADMIN_SESSION_COOKIE,
    requestHostHeader: e.REQUEST_HOST_HEADER,
    webDistDir: e.ADMIN_WEB_DIST_DIR ? path.resolve(e.ADMIN_WEB_DIST_DIR) : null,
  };
}
