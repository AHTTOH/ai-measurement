/**
 * 설정 로더 단위 테스트용 환경변수 묶음. 값은 infra/.env.example의 예시를 따른다.
 * 각 테스트는 이 묶음을 복사한 뒤 한 항목만 바꾸거나 빼서 쓴다(원본은 바꾸지 않는다).
 */

/** DB 공통 접속 변수와 프로세스별 계정 변수 */
export function databaseEnv(userVariable: string, passwordVariable: string): NodeJS.ProcessEnv {
  return {
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: '55432',
    DATABASE_NAME: 'ai_measurement',
    DATABASE_SSL: 'disable',
    [userVariable]: `${userVariable.toLowerCase()}_login`,
    [passwordVariable]: 'password-for-unit-tests-0001',
  };
}

/** 두 서버가 함께 쓰는 로그인 정책 변수 */
export const LOGIN_POLICY_ENV: Readonly<NodeJS.ProcessEnv> = {
  COOKIE_SECURE: 'false',
  REQUEST_HOST_HEADER: 'host',
  AUTH_SESSION_HOURS: '12',
  LOGIN_MAX_FAILURES: '5',
  LOGIN_LOCK_MINUTES: '15',
  LOGIN_ATTEMPTS_PER_IP_PER_MINUTE: '600',
};

/** 원본을 바꾸지 않고 항목 하나를 뺀 사본을 만든다 */
export function without(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));
}
