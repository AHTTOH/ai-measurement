import type { Database } from '@ai-measurement/infra';
import type { AdminServerConfig } from './config/admin-server-config';
import { MemoryAttemptLog } from './lib/attempt-log';
import type { Clock } from './lib/clock';
import type { Logger } from './lib/logger';
import { AdminResultsService } from './modules/admin/admin-results-service';
import { GradingJobService } from './modules/admin/grading-job-service';
import { SessionDetailService } from './modules/admin/session-detail-service';
import { SessionExtensionService } from './modules/admin/session-extension-service';
import { AdminAuthService } from './modules/auth/admin-auth-service';
import { AuthSessionStore } from './modules/auth/auth-session-store';
import { LoginThrottle, loginAttemptRetentionMs } from './modules/auth/login-throttle';
import { ExamAdminService } from './modules/exams/exam-admin-service';
import { ExamCatalog } from './modules/exams/exam-catalog';
import { ExamImportService } from './modules/exams/exam-import-service';
import { TokenLedgerService } from './modules/ledger/token-ledger-service';

/** 관리자 서버가 쓰는 서비스. AI 호출·응시 쓰기(대화·답안·제출)는 들어 있지 않다 */
export interface AdminServices {
  config: AdminServerConfig;
  logger: Logger;
  auth: AdminAuthService;
  catalog: ExamCatalog;
  examImport: ExamImportService;
  examAdmin: ExamAdminService;
  sessionExtension: SessionExtensionService;
  ledger: TokenLedgerService;
  adminResults: AdminResultsService;
  sessionDetail: SessionDetailService;
  gradingJobs: GradingJobService;
}

export interface AdminServiceDependencies {
  /** 관리자 서버 DB 역할(aim_admin_server)로 접속한 연결 */
  db: Database;
  config: AdminServerConfig;
  clock: Clock;
  logger: Logger;
}

/** 관리자 서버 구성 루트 */
export function buildAdminServices({ db, config, clock, logger }: AdminServiceDependencies): AdminServices {
  const catalog = new ExamCatalog(db, config.examsDir);
  const ledger = new TokenLedgerService(db);
  const gradingJobs = new GradingJobService(db, config.gradingLlmProvider);
  // 관리자 서버는 한 대이고, 수험생 서버 DB 역할이 관리자 로그인 잠금을 지우지 못하도록 메모리에 둔다
  const attempts = new MemoryAttemptLog(clock, loginAttemptRetentionMs(config.login));
  const throttle = new LoginThrottle(attempts, attempts, clock, config.login);
  return {
    config,
    logger,
    auth: new AdminAuthService(db, new AuthSessionStore(db, clock, config.login.authSessionHours), throttle),
    catalog,
    examImport: new ExamImportService(db, config.examsDir, config.uploadMaxBytes),
    examAdmin: new ExamAdminService(db, catalog, clock),
    sessionExtension: new SessionExtensionService(db),
    ledger,
    adminResults: new AdminResultsService(db, catalog, gradingJobs, config.gradingLlmProvider),
    sessionDetail: new SessionDetailService(db, catalog, ledger),
    gradingJobs,
  };
}
