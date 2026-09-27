/// <reference lib="dom" />
import AxeBuilder from '@axe-core/playwright';
import { expect, request, test, type Page, type TestInfo } from '@playwright/test';
import { E2E_ADMIN_URL } from './support/e2e-urls';

/**
 * 브라우저별 점검(Chromium·Firefox·WebKit·Edge). 전체 흐름(exam-lifecycle)이 시험을 등록하고 연 뒤에 돈다.
 * - 응시자 핵심 동작: 로그인, 안내 동의, 시작, 답안 자동저장, AI 전송·응답
 * - 접근성: axe로 WCAG 2.1 A·AA 위반 검사(심각·중대 위반 0)
 * - 반응형: 320·768·1024px에서 가로 스크롤이 생기지 않는다
 */
test.describe.configure({ mode: 'serial' });

const SAMPLE_TITLE = '샘플 AI 실무역량 평가';
const RESPONSIVE_WIDTHS = [320, 768, 1024] as const;
const RESPONSIVE_HEIGHT = 900;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
/** 이 등급 이상 위반이 있으면 실패한다 */
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

const admin = { username: process.env['E2E_ADMIN_USERNAME'], password: process.env['E2E_ADMIN_PASSWORD'] };
let candidate: { candidateNo: string; pin: string };

/** 프로젝트 이름으로 응시번호 접두사를 만든다(브라우저마다 다른 응시자) */
function prefixFor(info: TestInfo): string {
  return `X${info.project.name.replace(/[^A-Za-z]/gu, '').slice(0, 6).toUpperCase()}`;
}

async function expectNoBlockingA11yViolations(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const blocking = result.violations.filter((v) => v.impact !== null && v.impact !== undefined && BLOCKING_IMPACTS.has(v.impact));
  const summary = blocking.map((v) => `${v.id}(${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  expect(summary, `${label} 접근성 위반`).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // 화면 오른쪽 밖으로 나간 요소 중 자식이 넘치지 않는 가장 안쪽 요소를 원인으로 본다
    const outside = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => el.getBoundingClientRect().right > width + 1);
    const innermost = outside.filter((el) => !outside.some((other) => other !== el && el.contains(other)));
    return {
      overflow: document.documentElement.scrollWidth - width,
      offenders: innermost.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(el.getBoundingClientRect().right)}`),
    };
  });
  expect(overflow, `${label}: 가로 스크롤 ${overflow}px, 원인 후보 ${offenders.join(' | ')}`).toBeLessThanOrEqual(0);
}

test.beforeAll(async ({}, info) => {
  if (admin.username === undefined || admin.password === undefined) throw new Error('E2E 전역 설정이 운영자 계정을 넘기지 않았습니다');
  const api = await request.newContext({ baseURL: E2E_ADMIN_URL });
  expect((await api.post('/api/admin/login', { data: admin })).status()).toBe(200);
  const exams = (await (await api.get('/api/admin/exams')).json()) as { data: Array<{ id: string; title: string; status: string }> };
  const exam = exams.data.find((e) => e.title === SAMPLE_TITLE);
  if (exam === undefined || exam.status !== 'open') throw new Error('전체 흐름 테스트가 샘플 시험을 열어 두지 않았습니다');
  const generated = await api.post(`/api/admin/exams/${exam.id}/candidates`, { data: { prefix: prefixFor(info), count: 1 } });
  expect(generated.status()).toBe(201);
  candidate = ((await generated.json()) as { data: Array<{ candidateNo: string; pin: string }> }).data[0]!;
  await api.dispose();
});

test('응시자 화면: 로그인 화면은 접근성 위반이 없고 좁은 화면에서 가로로 넘치지 않는다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('응시번호')).toBeVisible();
  await expectNoBlockingA11yViolations(page, '로그인');
  for (const width of RESPONSIVE_WIDTHS) {
    await page.setViewportSize({ width, height: RESPONSIVE_HEIGHT });
    await expectNoHorizontalOverflow(page, `로그인 ${width}px`);
  }
});

test('응시자 화면: 시작하고 답안을 자동저장하고 AI와 대화한다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: RESPONSIVE_HEIGHT });
  await page.goto('/');
  await page.getByLabel('응시번호').fill(candidate.candidateNo);
  await page.getByLabel('PIN').fill(candidate.pin);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: SAMPLE_TITLE })).toBeVisible();
  await expectNoBlockingA11yViolations(page, '시작 전 안내');
  for (const width of RESPONSIVE_WIDTHS) {
    await page.setViewportSize({ width, height: RESPONSIVE_HEIGHT });
    await expectNoHorizontalOverflow(page, `시작 전 안내 ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: RESPONSIVE_HEIGHT });

  await page.getByLabel(/안내를 읽었으며/).check();
  await page.getByRole('button', { name: '시험 시작' }).click();
  await expect(page.getByRole('status', { name: /남은 토큰 40,000/ })).toBeVisible();

  await page.getByRole('button', { name: /1-2/ }).click();
  const selection = page.getByRole('region', { name: '분석 대상 데이터 선정' });
  await selection.getByLabel('1-2 답안').fill('브라우저별 점검 답안');
  await expect(selection.getByText(/저장됨/)).toBeVisible();

  await page.getByLabel('AI에게 보낼 내용').fill('이 자료에서 무엇을 먼저 봐야 하나요?');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByText('[모의 AI 응답] 실제 AI가 아닌 개발용 응답입니다.')).toBeVisible();
  await expectNoBlockingA11yViolations(page, '작업대');
  for (const width of RESPONSIVE_WIDTHS) {
    await page.setViewportSize({ width, height: RESPONSIVE_HEIGHT });
    await expectNoHorizontalOverflow(page, `작업대 ${width}px`);
  }
});

test('관리자 화면: 시험 목록과 상세는 접근성 위반이 없고 좁은 화면에서 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: RESPONSIVE_HEIGHT });
  await page.goto(`${E2E_ADMIN_URL}/admin/login`);
  await page.getByLabel('아이디').fill(admin.username ?? '');
  await page.getByLabel('비밀번호').fill(admin.password ?? '');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '시험', exact: true })).toBeVisible();
  await expectNoBlockingA11yViolations(page, '시험 목록');
  await page.getByRole('link', { name: SAMPLE_TITLE }).click();
  await expect(page.getByRole('cell', { name: candidate.candidateNo })).toBeVisible();
  await expectNoBlockingA11yViolations(page, '시험 상세');
  for (const width of RESPONSIVE_WIDTHS) {
    await page.setViewportSize({ width, height: RESPONSIVE_HEIGHT });
    await expectNoHorizontalOverflow(page, `시험 상세 ${width}px`);
  }
});
