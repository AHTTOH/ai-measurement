import { defineConfig } from 'vitest/config';

/** 단위 테스트: DB 없이 도는 테스트만 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // 파일마다 자식 프로세스를 띄우지 않는다(vitest.integration.config.ts 주석 참고)
    pool: 'threads',
    // 샘플 시험 패키지 검증(정규식 ReDoS 검사 포함)은 병렬 실행 중 5초를 넘길 수 있다(2026-09-27)
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['shared/src/**', 'server/src/**', 'grading/src/**'],
      reportsDirectory: 'workspace/coverage',
    },
  },
});
