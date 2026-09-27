import { defineConfig } from 'vitest/config';

/** 통합 테스트: 실제 PostgreSQL(embedded-postgres)을 한 번 띄워 파일마다 순서대로 쓴다 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/support/global-setup.ts'],
    fileParallelism: false,
    // 파일마다 자식 프로세스를 띄우지 않고 워커 스레드에서 돈다. Windows에서 프로세스 생성이 몰리면
    // 워커가 0xC0000142(DLL 초기화 실패)로 시작하지 못해 파일 하나가 통째로 실패한 적이 있다(2026-09-27 조사)
    pool: 'threads',
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
