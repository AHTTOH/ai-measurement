import { createDatabase, warmUpConnections } from '@ai-measurement/infra';
import { buildAdminApp } from './admin-app';
import { buildAdminServices } from './admin-services';
import { loadAdminServerConfig } from './config/admin-server-config';
import { loadConfigOrExit, requireDirectoryOrExit, serveUntilSignal } from './http/server-process';
import { systemClock } from './lib/clock';
import { consoleLogger } from './lib/logger';

/**
 * 관리자 서버 진입점. DB 역할 aim_admin_server로 접속한다.
 * 운영 PC에서만 열도록 ADMIN_SERVER_HOST를 좁히는 것을 권장한다(docs/runbook/시험-운영-절차.md).
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit(() => loadAdminServerConfig(process.env));
  await requireDirectoryOrExit(config.examsDir, 'EXAMS_DIR');

  const database = createDatabase(config.database, { maxConnections: config.databaseMaxConnections });
  await warmUpConnections(database, config.databaseMaxConnections);
  const services = buildAdminServices({ db: database.db, config, clock: systemClock, logger: consoleLogger });

  serveUntilSignal({
    name: 'admin_server',
    app: buildAdminApp(services),
    listen: config.listen,
    logger: consoleLogger,
    startInfo: { gradingLlmProvider: config.gradingLlmProvider },
    onShutdown: () => database.close(),
  });
}

await main();
