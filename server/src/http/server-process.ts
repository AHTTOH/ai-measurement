import { stat } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { DatabaseConnectionConfigError } from '@ai-measurement/infra';
import type { Hono } from 'hono';
import { ConfigError, type ListenConfig } from '../config/common-config';
import type { Logger } from '../lib/logger';

/** 설정을 읽고, 설정 오류면 메시지만 남기고 종료한다(스택 없이) */
export function loadConfigOrExit<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (error instanceof ConfigError || error instanceof DatabaseConnectionConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

export async function requireDirectoryOrExit(dir: string, variable: string): Promise<void> {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) {
    process.stderr.write(`${variable} 폴더가 없습니다: ${dir}\n`);
    process.exit(1);
  }
}

export interface ServeOptions {
  name: 'candidate_server' | 'admin_server';
  app: Hono;
  listen: ListenConfig;
  logger: Logger;
  /** 시작 로그에 함께 남길 값 */
  startInfo: Record<string, unknown>;
  /** 종료 신호를 받으면 HTTP 서버를 닫은 뒤 차례로 부른다 */
  onShutdown: () => Promise<void>;
}

/** HTTP 서버를 띄우고 SIGINT·SIGTERM에 정리 후 종료한다 */
export function serveUntilSignal(options: ServeOptions): void {
  const server = serve({ fetch: options.app.fetch, hostname: options.listen.host, port: options.listen.port }, (info) => {
    options.logger.info(`${options.name}_started`, { host: options.listen.host, port: info.port, ...options.startInfo });
  });
  const shutdown = (signal: string) => {
    options.logger.info(`${options.name}_stopping`, { signal });
    server.close(() => {
      options
        .onShutdown()
        .catch((error: unknown) => options.logger.error(`${options.name}_shutdown_failed`, { error }))
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
