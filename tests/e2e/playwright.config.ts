import { defineConfig, devices } from '@playwright/test';
import { E2E_CANDIDATE_URL } from './support/e2e-urls';

/**
 * 프로젝트 구성(2026-09-27):
 * - lifecycle: 전체 흐름(등록 → 응시 → 채점). Chromium에서 한 번 돈다. 시험을 등록하고 열어 둔다
 * - cross-*: 브라우저별 핵심 동작·접근성·반응형. lifecycle이 끝난 뒤 같은 시험에 브라우저마다 새 응시자로 돈다
 */
const LIFECYCLE = 'lifecycle-chromium';
const CROSS_BROWSERS = [
  { name: 'cross-chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'cross-firefox', use: { ...devices['Desktop Firefox'] } },
  { name: 'cross-webkit', use: { ...devices['Desktop Safari'] } },
  { name: 'cross-edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
];

export default defineConfig({
  testDir: '.',
  globalSetup: './support/e2e-environment.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: '../../workspace/e2e-results',
  use: {
    // 기본 주소는 수험생 서버. 관리자 화면은 E2E_ADMIN_URL(다른 포트의 관리자 서버)로 직접 연다
    baseURL: E2E_CANDIDATE_URL,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: LIFECYCLE, testMatch: 'exam-lifecycle.spec.ts', use: { ...devices['Desktop Chrome'] } },
    ...CROSS_BROWSERS.map((browser) => ({ ...browser, testMatch: 'cross-browser.spec.ts', dependencies: [LIFECYCLE] })),
  ],
});
