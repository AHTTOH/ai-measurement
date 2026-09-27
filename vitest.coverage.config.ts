import { defineConfig } from 'vitest/config';

/** 단위 + 통합 테스트를 함께 돌려 server·grading·shared 커버리지를 잰다(목표 80%) */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/support/global-setup.ts'],
    fileParallelism: false,
    // 파일마다 자식 프로세스를 띄우지 않고 워커 스레드에서 돈다. Windows에서 프로세스 생성이 몰리면
    // 워커가 0xC0000142(DLL 초기화 실패)로 시작하지 못해 파일 하나가 통째로 실패한 적이 있다(2026-09-27 조사)
    pool: 'threads',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['shared/src/**', 'server/src/**', 'grading/src/**'],
      // 진입점(프로세스 기동 코드)과 실제 API 호출부는 API 키 발급 후 별도로 검증한다
      exclude: [
        'server/src/candidate-main.ts',
        'server/src/admin-main.ts',
        'server/src/http/server-process.ts',
        'grading/src/worker-main.ts',
        'server/src/modules/ai/anthropic-gateway.ts',
        'grading/src/llm/anthropic-grader.ts',
      ],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'workspace/coverage',
    },
  },
});
