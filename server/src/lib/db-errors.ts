const UNIQUE_VIOLATION = '23505';

/**
 * PostgreSQL 유일 제약 위반인지 확인한다. Drizzle은 드라이버 오류를 cause에 감싸서 던지므로 원인 체인을 따라간다.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
