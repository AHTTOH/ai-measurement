import type { DatabaseHandle } from '@ai-measurement/infra';
import type { CandidateServerConfig } from './config/candidate-server-config';
import { MemoryAttemptLog, type AttemptLog } from './lib/attempt-log';
import { MS_PER_MINUTE, MS_PER_SECOND, type Clock } from './lib/clock';
import type { Logger } from './lib/logger';
import { PostgresAttemptLog } from './lib/postgres-attempt-log';
import { SlidingWindowLimiter } from './lib/sliding-window-limiter';
import type { AiGateway } from './modules/ai/ai-gateway';
import { ChatService } from './modules/ai/chat-service';
import { StreamHub, type StreamHubTiming } from './modules/ai/stream-hub';
import { AnswerService } from './modules/answers/answer-service';
import { AuthSessionStore } from './modules/auth/auth-session-store';
import { CandidateAuthService } from './modules/auth/candidate-auth-service';
import { LoginThrottle, loginAttemptRetentionMs } from './modules/auth/login-throttle';
import { CandidateStateService } from './modules/candidate/candidate-state-service';
import { ExamCatalog } from './modules/exams/exam-catalog';
import { TokenLedgerService } from './modules/ledger/token-ledger-service';
import { MaterialService } from './modules/materials/material-service';
import { NoticeService } from './modules/notices/notice-service';
import { ExamSessionService } from './modules/sessions/exam-session-service';

/** 수험생 서버가 쓰는 서비스. 관리자 기능(시험 등록·응시자 발급·채점·연장·환불)은 들어 있지 않다 */
export interface CandidateServices {
  config: CandidateServerConfig;
  logger: Logger;
  auth: CandidateAuthService;
  catalog: ExamCatalog;
  sessions: ExamSessionService;
  ledger: TokenLedgerService;
  materials: MaterialService;
  notices: NoticeService;
  answers: AnswerService;
  chat: ChatService;
  hub: StreamHub;
  candidateState: CandidateStateService;
  /** 요청 한도·로그인 잠금 기록(여러 서버가 나눠 쓴다) */
  attempts: AttemptLog;
  /** 이보다 오래된 시도 기록은 정리해도 된다(가장 긴 창보다 길다) */
  attemptRetentionMs: number;
}

/**
 * 응답 스트림 조정 시간값. 다른 서버에 붙은 응시자가 늦게 받는 정도와 죽은 서버를 알아채는 속도를 정한다.
 * 결정: docs/decisions/2026-09-27-수험생-서버-다중-인스턴스.md
 */
export const STREAM_HUB_TIMING: StreamHubTiming = {
  heartbeatMs: 5 * MS_PER_SECOND,
  staleMs: 20 * MS_PER_SECOND,
  notifyIntervalMs: 50,
  snapshotTimeoutMs: 3 * MS_PER_SECOND,
  finishedRetentionMs: MS_PER_MINUTE,
};

export interface CandidateServiceDependencies {
  /** 수험생 서버 DB 역할(aim_candidate_server)로 접속한 연결. LISTEN/NOTIFY에 원본 클라이언트도 쓴다 */
  database: Pick<DatabaseHandle, 'db' | 'client'>;
  streamTiming: StreamHubTiming;
  config: CandidateServerConfig;
  clock: Clock;
  ai: AiGateway;
  logger: Logger;
}

/** 수험생 서버 구성 루트. 모듈끼리는 여기서 주입받은 서비스만 쓴다 */
export function buildCandidateServices({ database, streamTiming, config, clock, ai, logger }: CandidateServiceDependencies): CandidateServices {
  const { db } = database;
  const catalog = new ExamCatalog(db, config.examsDir);
  const ledger = new TokenLedgerService(db);
  const sessions = new ExamSessionService(db, catalog, ledger, clock);
  const notices = new NoticeService(db, clock);
  const materials = new MaterialService(catalog);
  const hub = new StreamHub(database, streamTiming, logger);
  const attempts = new PostgresAttemptLog(db);
  const aiLimiter = new SlidingWindowLimiter(attempts, clock, 'ai', config.candidateAiRequestsPerMinute, MS_PER_MINUTE);
  const chat = new ChatService(db, catalog, sessions, ledger, materials, ai, hub, clock, aiLimiter, logger);
  const answers = new AnswerService(db, catalog, sessions, notices, clock);
  // 계정 잠금은 서버 전체(DB), IP 한도는 이 서버의 CPU 보호용이라 서버별 메모리(login-throttle.ts 설명)
  const throttle = new LoginThrottle(attempts, new MemoryAttemptLog(clock, loginAttemptRetentionMs(config.login)), clock, config.login);
  return {
    config,
    logger,
    auth: new CandidateAuthService(db, new AuthSessionStore(db, clock, config.login.authSessionHours), throttle),
    catalog,
    sessions,
    ledger,
    materials,
    notices,
    answers,
    chat,
    hub,
    candidateState: new CandidateStateService(db, catalog, sessions, ledger, answers, notices, chat, ai, clock),
    attempts,
    attemptRetentionMs: loginAttemptRetentionMs(config.login),
  };
}
