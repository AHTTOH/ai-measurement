import path from 'node:path';
import { databaseConnectionFromEnv, type DatabaseConnection } from '@ai-measurement/infra';
import { z } from 'zod';
import { cookieNameSchema, hostSchema, loginPolicyEnvShape, requestHostHeaderSchema, type RequestHostHeader, loginPolicyFrom, parseEnv, portSchema, type ListenConfig, type LoginPolicy } from './common-config';

/**
 * 수험생 서버 환경변수. 모두 필수이며 코드 쪽 기본값이 없다(폴백 금지). 뜻은 infra/.env.example.
 * 관리자 기능(시험 등록·채점)에 필요한 값은 받지 않는다.
 */
const candidateEnvSchema = z
  .object({
    CANDIDATE_SERVER_HOST: hostSchema,
    CANDIDATE_SERVER_PORT: portSchema,
    CANDIDATE_SESSION_COOKIE: cookieNameSchema,
    REQUEST_HOST_HEADER: requestHostHeaderSchema,
    CANDIDATE_SERVER_DB_MAX_CONNECTIONS: z.coerce.number().int().min(1),
    CANDIDATE_WEB_DIST_DIR: z.string().min(1).optional(),
    EXAMS_DIR: z.string().min(1),
    AI_PROVIDER: z.enum(['anthropic', 'mock']),
    ANTHROPIC_API_KEY: z.string().optional(),
    /** 모의 AI 응답 조각 사이 지연(ms). AI_PROVIDER=mock일 때만 필수 */
    MOCK_AI_CHUNK_DELAY_MS: z.coerce.number().int().min(0).optional(),
    CANDIDATE_AI_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1),
    SESSION_SWEEP_SECONDS: z.coerce.number().int().min(1),
    ...loginPolicyEnvShape,
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'anthropic' && (env.ANTHROPIC_API_KEY ?? '').trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'AI_PROVIDER=anthropic이면 필수입니다' });
    }
    if (env.AI_PROVIDER === 'mock' && env.MOCK_AI_CHUNK_DELAY_MS === undefined) {
      ctx.addIssue({ code: 'custom', path: ['MOCK_AI_CHUNK_DELAY_MS'], message: 'AI_PROVIDER=mock이면 필수입니다' });
    }
  });

export interface CandidateServerConfig {
  database: DatabaseConnection;
  databaseMaxConnections: number;
  listen: ListenConfig;
  examsDir: string;
  aiProvider: 'anthropic' | 'mock';
  anthropicApiKey: string | null;
  /** AI_PROVIDER=mock일 때만 값이 있다 */
  mockAiChunkDelayMs: number | null;
  candidateAiRequestsPerMinute: number;
  sessionSweepSeconds: number;
  login: LoginPolicy;
  /** 로그인 쿠키 이름 */
  sessionCookie: string;
  /** 같은 출처 검사에서 요청 주소로 볼 헤더 */
  requestHostHeader: RequestHostHeader;
  /** 빌드된 수험생 웹(web/dist/candidate)을 함께 제공할 때 경로. 없으면 API만 제공 */
  webDistDir: string | null;
}

export function loadCandidateServerConfig(env: NodeJS.ProcessEnv): CandidateServerConfig {
  const e = parseEnv(candidateEnvSchema, env, '수험생 서버');
  return {
    database: databaseConnectionFromEnv(env, 'CANDIDATE_SERVER_DB_USER', 'CANDIDATE_SERVER_DB_PASSWORD'),
    databaseMaxConnections: e.CANDIDATE_SERVER_DB_MAX_CONNECTIONS,
    listen: { host: e.CANDIDATE_SERVER_HOST, port: e.CANDIDATE_SERVER_PORT },
    examsDir: path.resolve(e.EXAMS_DIR),
    aiProvider: e.AI_PROVIDER,
    anthropicApiKey: e.ANTHROPIC_API_KEY?.trim() ? e.ANTHROPIC_API_KEY.trim() : null,
    mockAiChunkDelayMs: e.AI_PROVIDER === 'mock' ? (e.MOCK_AI_CHUNK_DELAY_MS ?? null) : null,
    candidateAiRequestsPerMinute: e.CANDIDATE_AI_REQUESTS_PER_MINUTE,
    sessionSweepSeconds: e.SESSION_SWEEP_SECONDS,
    login: loginPolicyFrom(e),
    sessionCookie: e.CANDIDATE_SESSION_COOKIE,
    requestHostHeader: e.REQUEST_HOST_HEADER,
    webDistDir: e.CANDIDATE_WEB_DIST_DIR ? path.resolve(e.CANDIDATE_WEB_DIST_DIR) : null,
  };
}
