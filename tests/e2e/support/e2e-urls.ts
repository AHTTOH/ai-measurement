/** E2E 전용 포트. 로컬 개발 서버(3000, 3001)와 겹치지 않게 둔다 */
export const E2E_CANDIDATE_PORT = 43917;
export const E2E_ADMIN_PORT = 43918;

/** 서버가 IPv4(127.0.0.1)에만 붙으므로 localhost(IPv6 먼저 시도) 대신 IPv4 주소를 쓴다 */
export const E2E_CANDIDATE_URL = `http://127.0.0.1:${E2E_CANDIDATE_PORT}`;
export const E2E_ADMIN_URL = `http://127.0.0.1:${E2E_ADMIN_PORT}`;
