import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN_URL } from './support/e2e-urls';

/**
 * 핵심 흐름 E2E: 운영자가 시험을 등록·열고 응시자를 발급 → 응시자가 응시(답안·공지·AI·첨부) → 운영자가 채점하고 결과를 본다.
 * 각 단계 화면을 workspace/e2e-screenshots에 남겨 디자인 자기 점검에 쓴다.
 */
test.describe.configure({ mode: 'serial' });

const screenshotDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'workspace', 'e2e-screenshots');
const admin = { username: process.env['E2E_ADMIN_USERNAME'] ?? '', password: process.env['E2E_ADMIN_PASSWORD'] ?? '' };
let candidate: { candidateNo: string; pin: string };

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function loginAdmin(page: Page): Promise<void> {
  expect(admin.username, 'E2E 전역 설정이 운영자 계정을 만들지 않았습니다').not.toBe('');
  await page.goto(`${E2E_ADMIN_URL}/admin/login`);
  await page.getByLabel('아이디').fill(admin.username);
  await page.getByLabel('비밀번호').fill(admin.password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '시험', exact: true })).toBeVisible();
}

test('운영자: 시험 패키지를 등록하고 열고 응시자를 발급한다', async ({ page }) => {
  await loginAdmin(page);
  const sampleRow = page.getByRole('row', { name: /sample-ai-practice/ });
  await expect(sampleRow.getByText('통과')).toBeVisible();
  await sampleRow.getByRole('button', { name: '등록' }).click();
  await expect(page.getByText('sample-ai-practice를 등록했습니다')).toBeVisible();
  await shot(page, '01-admin-exam-list');

  await page.getByRole('link', { name: '샘플 AI 실무역량 평가' }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '시험 열기' }).click();
  await expect(page.getByText('진행', { exact: true })).toBeVisible();

  await page.getByLabel('응시번호 접두사').fill('E2E');
  await page.getByLabel('인원').fill('2');
  const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/candidates') && r.request().method() === 'POST'), page.getByRole('button', { name: '발급' }).click()]);
  const body = (await response.json()) as { data: Array<{ candidateNo: string; pin: string }> };
  candidate = body.data[0]!;
  await expect(page.getByText('PIN은 지금 한 번만 볼 수 있습니다.')).toBeVisible();
  await expect(page.getByRole('link', { name: candidate.candidateNo })).toHaveCount(0); // 아직 응시 전
  await expect(page.getByRole('cell', { name: candidate.candidateNo })).toBeVisible();
});

test('응시자: 로그인하고 문항을 풀고 공지를 받고 AI를 쓰고 시험을 끝낸다', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('응시번호').fill(candidate.candidateNo);
  await page.getByLabel('PIN').fill(candidate.pin);
  await page.getByRole('button', { name: '로그인' }).click();

  await expect(page.getByRole('heading', { name: '샘플 AI 실무역량 평가' })).toBeVisible();
  await shot(page, '02-candidate-lobby');
  await page.getByLabel(/안내를 읽었으며/).check();
  await page.getByRole('button', { name: '시험 시작' }).click();

  await expect(page.getByRole('status', { name: /남은 토큰 40,000/ })).toBeVisible();
  await expect(page.getByText('모의 AI')).toBeVisible();

  // 한 페이지 문서: 목차를 누르면 그 문항으로 이동한다. 버튼·입력은 문항 구역 안에서 찾는다
  const review = page.getByRole('region', { name: '자료 검토' });
  await page.getByRole('button', { name: /1-1 자료 검토/ }).click();
  for (const label of ['성명', '주민등록번호', '휴대전화', '비고']) await review.getByLabel(label, { exact: true }).check();
  await review.getByLabel('비고(선택 근거)').fill('비고 컬럼에 AI 지시문이 들어 있다');
  await review.getByRole('button', { name: '임시 저장' }).click();
  await expect(review.getByText(/저장됨/)).toBeVisible();
  await review.getByRole('button', { name: '최종 제출' }).click();
  await expect(page.getByRole('button', { name: /1-1 자료 검토 제출됨/ })).toBeVisible();

  // 1-3 서술형: 자동저장 후 제출하면 개인정보 공지가 열린다
  const analysis = page.getByRole('region', { name: 'AI 활용 분석' });
  await page.getByRole('button', { name: /1-3 AI 활용 분석/ }).click();
  await expect(analysis.getByText('유의사항')).toBeVisible();
  await analysis.getByLabel('1-3 답안').fill(['| 부서 | 인원 |', '| --- | --- |', '| 영업1팀 | 12 |'].join('\n'));
  await expect(analysis.getByText(/저장됨/)).toBeVisible();
  await analysis.getByRole('button', { name: '최종 제출' }).click();
  await expect(page.getByRole('region', { name: '새 공지' }).getByRole('heading', { name: '분석 결과 공개 범위 추가 지침' })).toBeVisible();
  await shot(page, '03-candidate-notice');
  await page.getByRole('button', { name: '확인' }).click();

  // 자료 첨부: 필요한 컬럼만 골라 보낸다
  await page.getByRole('button', { name: '직원 명부 첨부' }).click();
  const sheet = page.getByRole('dialog');
  for (const column of ['부서', '직무만족도', '이직의향']) await sheet.getByLabel(column, { exact: true }).check();
  await sheet.getByRole('button', { name: '행 모두 선택' }).click();
  await expect(sheet.getByRole('button', { name: '열 모두 선택' })).toBeVisible();
  await shot(page, '04-candidate-attach-sheet');
  await sheet.getByRole('button', { name: '이 선택으로 첨부' }).click();
  await expect(page.getByText('직원 명부 CSV 3열 48행')).toBeVisible();
  await page.getByLabel('AI에게 보낼 내용').fill('부서별 인원, 평균 직무만족도, 이직의향 비율을 표로 만들어줘. 5명 미만 조직은 합산해줘.');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByText(/토큰 [\d,]+ 차감/)).toBeVisible();
  await expect(page.getByText('[모의 AI 응답] 실제 AI가 아닌 개발용 응답입니다.')).toBeVisible();
  await expect(page.getByRole('status', { name: /남은 토큰 (?!40,000)/ })).toBeVisible();
  await shot(page, '05-candidate-workspace');

  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, '06-candidate-workspace-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '시험 종료' }).click();
  await expect(page.getByRole('heading', { name: '시험이 끝났습니다' })).toBeVisible();
});

test('운영자: 채점을 실행하고 응시자별 결과와 도달 과정을 본다', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAdmin(page);
  await page.getByRole('link', { name: '샘플 AI 실무역량 평가' }).click();
  await page.getByLabel('LLM 채점 방식').selectOption('direct');
  await page.getByRole('button', { name: '채점 실행' }).click();
  await expect(page.getByRole('cell', { name: '완료' })).toBeVisible({ timeout: 60_000 });
  const row = page.getByRole('row', { name: new RegExp(candidate.candidateNo) });
  await expect(row.getByText('모의')).toBeVisible();
  await shot(page, '07-admin-exam-results');

  await row.getByRole('link', { name: candidate.candidateNo }).click();
  await expect(page.getByText('AI 실무역량', { exact: true })).toBeVisible();
  await expect(page.getByText('모의 채점', { exact: true })).toBeVisible();
  await shot(page, '08-admin-session-grades');
  await page.getByRole('tab', { name: '대화' }).click();
  await expect(page.getByText(/직원 명부 CSV \[부서, 직무만족도, 이직의향\] 48행/)).toBeVisible();
  await page.getByRole('tab', { name: '토큰 원장' }).click();
  await expect(page.getByRole('cell', { name: '전송' })).toBeVisible();
  await shot(page, '09-admin-session-ledger');
});
