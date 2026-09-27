/** 한 줄 JSON 로그. 서버와 채점 워커가 함께 쓰고, 운영 로그 수집기에 그대로 넘길 수 있다 */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function serialize(level: 'info' | 'error', event: string, fields: Record<string, unknown> | undefined): string {
  const normalized = Object.fromEntries(
    Object.entries(fields ?? {}).map(([key, value]) => [key, value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, cause: String(value.cause ?? '') } : value]),
  );
  return JSON.stringify({ at: new Date().toISOString(), level, event, ...normalized });
}

export const consoleLogger: Logger = {
  info: (event, fields) => process.stdout.write(`${serialize('info', event, fields)}\n`),
  error: (event, fields) => process.stderr.write(`${serialize('error', event, fields)}\n`),
};

/** 테스트용: 아무것도 출력하지 않는다 */
export const silentLogger: Logger = {
  info: () => {},
  error: () => {},
};
