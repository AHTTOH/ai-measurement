import { renderCsv } from '@ai-measurement/shared/node';
import { CSV_BOM, formatWon, markdownTable, type CaseBundle } from './case-bundle';
import { FictionalPeople } from './fictional-people';
import { buildPdf, type PdfBlock, type PdfFonts } from './pdf-writer';
import { createSeededRandom } from './random';

/**
 * Case 3. 출장비 규정 검토 (PDF 규정 + CSV 신청 내역).
 * 함정: 대외비 쪽이 섞인 규정 PDF, 신청자 성명, 합계가 틀린 신청 건, 사전 승인 예외, 진행 중 일비 한도 변경.
 */

const CASE_KEY = 'travel-expense';
const POLICY_KEY = 'travel-policy';
const POLICY_FILE = 'materials/travel-policy.pdf';
const EXPENSES_KEY = 'expenses';
const EXPENSES_FILE = 'materials/expenses.csv';
const NOTICE_KEY = 'overseas-per-diem-change';

type Region = '국내' | '해외';
type Rank = '사원' | '대리' | '과장' | '차장' | '부장';

const LODGING_LIMIT: Record<Region, Record<Rank, number>> = {
  국내: { 사원: 80_000, 대리: 80_000, 과장: 100_000, 차장: 100_000, 부장: 120_000 },
  해외: { 사원: 200_000, 대리: 200_000, 과장: 200_000, 차장: 200_000, 부장: 250_000 },
};
const PER_DIEM_LIMIT: Record<Region, number> = { 국내: 30_000, 해외: 70_000 };
const NEW_OVERSEAS_PER_DIEM_LIMIT = 60_000;
const PER_DIEM_BY_MODE: Record<Region, Record<'normal' | 'between' | 'over', number>> = {
  국내: { normal: 30_000, between: 30_000, over: 35_000 },
  해외: { normal: 60_000, between: 65_000, over: 75_000 },
};
const DESTINATIONS: Record<Region, readonly string[]> = {
  국내: ['부산', '대구', '광주', '대전', '제주', '강릉'],
  해외: ['도쿄', '싱가포르', '하노이', '프랑크푸르트'],
};

interface Scenario {
  region: Region;
  rank: Rank;
  days: number;
  lodging: 'under' | 'over';
  perDiem: 'normal' | 'between' | 'over';
  approved: boolean;
  sumError: boolean;
}

/** 위반·예외·계산 오류가 고르게 섞이도록 신청 24건의 시나리오를 명시적으로 정한다 */
const SCENARIOS: readonly Scenario[] = [
  { region: '국내', rank: '사원', days: 3, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '대리', days: 2, lodging: 'over', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '과장', days: 4, lodging: 'under', perDiem: 'normal', approved: false, sumError: true },
  { region: '해외', rank: '차장', days: 5, lodging: 'under', perDiem: 'between', approved: false, sumError: false },
  { region: '국내', rank: '부장', days: 3, lodging: 'under', perDiem: 'over', approved: false, sumError: false },
  { region: '국내', rank: '사원', days: 2, lodging: 'over', perDiem: 'normal', approved: true, sumError: false },
  { region: '해외', rank: '과장', days: 4, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '대리', days: 3, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '차장', days: 2, lodging: 'over', perDiem: 'normal', approved: false, sumError: false },
  { region: '해외', rank: '사원', days: 6, lodging: 'under', perDiem: 'over', approved: false, sumError: false },
  { region: '국내', rank: '과장', days: 3, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '사원', days: 4, lodging: 'under', perDiem: 'normal', approved: false, sumError: true },
  { region: '해외', rank: '부장', days: 5, lodging: 'over', perDiem: 'normal', approved: true, sumError: false },
  { region: '국내', rank: '부장', days: 2, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '대리', days: 5, lodging: 'under', perDiem: 'over', approved: false, sumError: false },
  { region: '해외', rank: '대리', days: 3, lodging: 'under', perDiem: 'between', approved: false, sumError: false },
  { region: '국내', rank: '과장', days: 2, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '사원', days: 3, lodging: 'over', perDiem: 'normal', approved: false, sumError: true },
  { region: '국내', rank: '차장', days: 4, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '해외', rank: '과장', days: 4, lodging: 'under', perDiem: 'between', approved: true, sumError: false },
  { region: '국내', rank: '대리', days: 2, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '부장', days: 3, lodging: 'over', perDiem: 'normal', approved: false, sumError: false },
  { region: '국내', rank: '사원', days: 2, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
  { region: '해외', rank: '차장', days: 3, lodging: 'under', perDiem: 'normal', approved: false, sumError: false },
];

interface Claim {
  id: string;
  applicant: string;
  scenario: Scenario;
  destination: string;
  nights: number;
  nightly: number;
  lodging: number;
  perDiemDaily: number;
  perDiem: number;
  transport: number;
  total: number;
  correctTotal: number;
}

function generateClaims(): Claim[] {
  const random = createSeededRandom(777);
  const people = new FictionalPeople(random);
  return SCENARIOS.map((scenario, index) => {
    const limit = LODGING_LIMIT[scenario.region][scenario.rank];
    const nightly = scenario.lodging === 'over' ? limit + random.pick([5_000, 10_000, 20_000]) : limit - random.pick([0, 5_000, 10_000, 15_000]);
    const nights = scenario.days - 1;
    const perDiemDaily = PER_DIEM_BY_MODE[scenario.region][scenario.perDiem];
    const transport = scenario.region === '국내' ? random.int(30, 180) * 1_000 : random.int(40, 120) * 10_000;
    const lodging = nightly * nights;
    const perDiem = perDiemDaily * scenario.days;
    const correctTotal = lodging + perDiem + transport;
    const total = scenario.sumError ? correctTotal + random.pick([10_000, -10_000, 9_000]) : correctTotal;
    return {
      id: `T-2026-${String(index + 1).padStart(3, '0')}`,
      applicant: people.uniqueName(),
      scenario,
      destination: random.pick(DESTINATIONS[scenario.region]),
      nights,
      nightly,
      lodging,
      perDiemDaily,
      perDiem,
      transport,
      total,
      correctTotal,
    };
  });
}

interface Excess {
  claim: Claim;
  lodgingExcess: number;
  perDiemExcess: number;
}

function excessOf(claim: Claim, overseasPerDiemLimit: number): Excess {
  const { region, rank } = claim.scenario;
  const perDiemLimit = region === '해외' ? overseasPerDiemLimit : PER_DIEM_LIMIT[region];
  return {
    claim,
    lodgingExcess: Math.max(0, claim.nightly - LODGING_LIMIT[region][rank]) * claim.nights,
    perDiemExcess: Math.max(0, claim.perDiemDaily - perDiemLimit) * claim.scenario.days,
  };
}

function violations(claims: readonly Claim[], overseasPerDiemLimit: number): Excess[] {
  return claims
    .filter((c) => !c.scenario.approved)
    .map((c) => excessOf(c, overseasPerDiemLimit))
    .filter((e) => e.lodgingExcess > 0 || e.perDiemExcess > 0);
}

function excessTable(items: readonly Excess[]): string {
  return markdownTable(
    ['신청번호', '초과 항목', '초과 금액'],
    items.map((e) => {
      const parts = [e.lodgingExcess > 0 ? '숙박비' : '', e.perDiemExcess > 0 ? '일비' : ''].filter(Boolean);
      return [e.claim.id, parts.join('·'), formatWon(e.lodgingExcess + e.perDiemExcess)];
    }),
  );
}

function policyPages(): PdfBlock[][] {
  const won = (n: number) => n.toLocaleString('ko-KR');
  const l = LODGING_LIMIT;
  return [
    [
      { kind: 'heading', text: '한빛상사 출장비 지급 규정' },
      { kind: 'paragraph', text: '이 문서는 시험용으로 만든 가공 자료입니다. 실제 기업과 관계가 없습니다.' },
      { kind: 'paragraph', text: '제1조(목적) 이 규정은 임직원의 국내·해외 출장에 드는 경비의 지급 기준을 정한다.' },
      { kind: 'paragraph', text: '제2조(적용 범위) 이 규정은 정규직과 계약직 임직원에게 적용한다. 임원 보상은 별도 기준에 따른다.' },
      { kind: 'paragraph', text: '제3조(용어) 출장일수는 출발일과 복귀일을 포함한 일수를 말하며, 숙박일수는 출장일수에서 1을 뺀 값으로 한다.' },
    ],
    [
      { kind: 'heading', text: '제4조(지급 한도)' },
      { kind: 'paragraph', text: '① 숙박비는 1박 기준으로 다음 한도 안에서 실비를 지급한다.' },
      { kind: 'paragraph', text: `국내: 사원·대리 ${won(l.국내.사원)}원 / 과장·차장 ${won(l.국내.과장)}원 / 부장 ${won(l.국내.부장)}원` },
      { kind: 'paragraph', text: `해외: 사원부터 차장까지 ${won(l.해외.사원)}원 / 부장 ${won(l.해외.부장)}원` },
      { kind: 'paragraph', text: `② 일비는 출장일수 1일당 국내 ${won(PER_DIEM_LIMIT.국내)}원, 해외 ${won(PER_DIEM_LIMIT.해외)}원을 한도로 지급한다.` },
      { kind: 'paragraph', text: '③ 교통비는 실비로 지급한다.' },
      { kind: 'paragraph', text: '④ 한도를 넘는 금액은 지급하지 않는다. 단, 제7조의 사전 승인을 받은 경우는 예외로 한다.' },
    ],
    [
      { kind: 'label', text: '[대외비] 보상위원회 외 열람 및 외부 전달 금지' },
      { kind: 'heading', text: '임원 보상 및 성과급 지급 기준' },
      { kind: 'paragraph', text: '임원 성과급 지급률은 경영 성과 등급에 따라 기본 연봉의 20%에서 60% 사이로 정한다.' },
      { kind: 'paragraph', text: '장기 인센티브 부여 기준은 3개년 누적 영업이익 목표 달성률 90% 이상일 때 적용한다.' },
      { kind: 'paragraph', text: '이 쪽의 내용은 보상위원회 위원 외에는 열람할 수 없다.' },
    ],
    [
      { kind: 'heading', text: '제5조부터 제7조 및 부칙' },
      { kind: 'paragraph', text: '제5조(증빙) 숙박비와 교통비는 영수증을 첨부해야 한다.' },
      { kind: 'paragraph', text: '제6조(정산) 출장 신청서의 합계는 숙박비, 일비, 교통비의 합과 같아야 하며, 다르면 반려한다.' },
      { kind: 'paragraph', text: '제7조(사전 승인) 부서장의 사전 승인을 받은 출장은 제4조의 한도를 넘더라도 실비를 지급한다.' },
      { kind: 'paragraph', text: '부칙: 이 규정은 2026년 1월 1일부터 시행한다.' },
    ],
  ];
}

export async function buildTravelExpenseCase(fonts: PdfFonts): Promise<CaseBundle> {
  const claims = generateClaims();
  const csv = renderCsv({
    headers: ['신청번호', '신청자', '직급', '구분', '출장지', '출장일수', '숙박일수', '숙박비', '일비', '교통비', '합계', '사전승인'],
    rows: claims.map((c) => [c.id, c.applicant, c.scenario.rank, c.scenario.region, c.destination, String(c.scenario.days), String(c.nights), String(c.lodging), String(c.perDiem), String(c.transport), String(c.total), c.scenario.approved ? 'Y' : 'N']),
  });
  const pdf = await buildPdf('한빛상사 출장비 지급 규정', policyPages(), fonts);
  const oldViolations = violations(claims, PER_DIEM_LIMIT.해외);
  const newViolations = violations(claims, NEW_OVERSEAS_PER_DIEM_LIMIT);
  const sumErrors = claims.filter((c) => c.total !== c.correctTotal);

  return {
    files: [
      { relativePath: POLICY_FILE, content: pdf },
      { relativePath: EXPENSES_FILE, content: CSV_BOM + csv },
    ],
    caseDef: {
      key: CASE_KEY,
      title: '출장비 규정 검토',
      brief: [
        '당신은 가상 기업 한빛상사 재무팀 담당자입니다.',
        '이번 달 출장비 신청 24건(expenses.csv)을 출장비 지급 규정(travel-policy.pdf)에 따라 검토해 반려 대상을 가려야 합니다.',
        '규정 문서에는 이번 업무와 관계없는 쪽이 들어 있을 수 있습니다.',
      ].join('\n'),
      materials: [
        { key: POLICY_KEY, title: '출장비 지급 규정', kind: 'pdf', file: POLICY_FILE },
        { key: EXPENSES_KEY, title: '출장비 신청 내역', kind: 'csv', file: EXPENSES_FILE },
      ],
      subquestions: [
        {
          key: '3-1',
          title: '자료 검토',
          type: 'review',
          prompt: '이번 과제에서 AI에 전달하면 안 되는 자료를 모두 고르십시오.',
          unlockedByNotice: null,
          answer: {
            kind: 'multi_choice',
            options: [
              { id: 'policy-p1', label: '규정 1쪽: 목적·적용 범위·용어' },
              { id: 'policy-p2', label: '규정 2쪽: 지급 한도' },
              { id: 'policy-p3', label: '규정 3쪽: 임원 보상 기준' },
              { id: 'policy-p4', label: '규정 4쪽: 증빙·정산·사전 승인·부칙' },
              { id: 'applicant-name', label: '신청 내역의 신청자 컬럼' },
              { id: 'amounts', label: '신청 내역의 금액 컬럼' },
            ],
          },
        },
        {
          key: '3-2',
          title: 'AI 활용 검토',
          type: 'ai_task',
          prompt: '규정과 신청 내역을 바탕으로 한도를 넘은 신청 건을 찾아 신청번호, 초과 항목, 초과 금액을 표로 정리하십시오.',
          unlockedByNotice: null,
          answer: { kind: 'text' },
        },
        {
          key: '3-3',
          title: '수치 검증',
          type: 'verify',
          prompt: '신청 내역의 합계가 맞는지 검증하고, 계산이 틀린 신청번호를 적으십시오. AI 결과를 어떻게 검증했는지도 쓰십시오.',
          unlockedByNotice: null,
          answer: { kind: 'text' },
        },
        {
          key: '3-4',
          title: '결재 의견서',
          type: 'final',
          prompt: '반려 대상과 사유를 담은 결재 의견서를 작성하십시오. 사유는 규정 조항과 연결하십시오.',
          unlockedByNotice: null,
          answer: { kind: 'text' },
        },
        {
          key: '3-5',
          title: '변경 기준 재검토',
          type: 'final',
          prompt: `변경된 해외 일비 한도(1일 ${NEW_OVERSEAS_PER_DIEM_LIMIT.toLocaleString('ko-KR')}원)로 다시 검토한 결과를 적으십시오. 새로 반려 대상이 되는 신청번호와 전체 반려 건수를 포함하십시오.`,
          unlockedByNotice: NOTICE_KEY,
          answer: { kind: 'text' },
        },
      ],
      notices: [
        {
          key: NOTICE_KEY,
          from: '재무팀장',
          title: '해외 출장 일비 한도 변경',
          body: `이번 심사부터 해외 출장 일비 한도를 1일 ${PER_DIEM_LIMIT.해외.toLocaleString('ko-KR')}원에서 ${NEW_OVERSEAS_PER_DIEM_LIMIT.toLocaleString('ko-KR')}원으로 낮춰 적용합니다. 해외 출장 신청 건을 새 기준으로 다시 검토하고 결재 의견서(3-4)에도 반영하십시오. 새로 열린 3-5 문항에 재검토 결과를 적으십시오.`,
          reveal: { after: 'elapsed_minutes', minutes: 60 },
        },
      ],
    },
    answerKey: {
      caseKey: CASE_KEY,
      materials: {
        [POLICY_KEY]: {
          kind: 'pdf',
          pages: [
            {
              id: 'page-3',
              label: '규정 3쪽 임원 보상 기준(대외비)',
              page: 3,
              tags: ['confidential'],
              fingerprint: { type: 'text', texts: ['임원 성과급 지급률', '장기 인센티브 부여 기준'] },
            },
          ],
        },
        [EXPENSES_KEY]: {
          kind: 'csv',
          columns: {
            신청자: { label: '신청자 성명', tags: ['pii'], fingerprint: { type: 'cell_values', minLength: 3 } },
            직급: { label: '직급', tags: ['needed'], fingerprint: { type: 'cell_values', minLength: 2 } },
            숙박비: { label: '숙박비', tags: ['needed'], fingerprint: { type: 'cell_values', minLength: 5 } },
            일비: { label: '일비', tags: ['needed'], fingerprint: { type: 'cell_values', minLength: 5 } },
            합계: { label: '합계', tags: ['needed'], fingerprint: { type: 'cell_values', minLength: 5 } },
          },
          rows: [],
        },
      },
      choiceAnswers: { '3-1': ['policy-p3', 'applicant-name'] },
      referenceAnswers: {
        '3-2': `${excessTable(oldViolations)}\n\n사전 승인(Y)을 받은 신청은 제7조에 따라 한도 초과로 보지 않는다. 한도 초과 신청은 모두 ${oldViolations.length}건이다.`,
        '3-3': `합계가 숙박비·일비·교통비의 합과 다른 신청: ${sumErrors.map((c) => `${c.id}(신고 ${formatWon(c.total)}, 실제 ${formatWon(c.correctTotal)})`).join(', ')}. 모두 ${sumErrors.length}건이며 제6조에 따라 반려 대상이다.`,
        '3-4': '반려 대상은 제4조 한도 초과(사전 승인 없는 건)와 제6조 합계 불일치 건이다. 신청번호별로 해당 조항과 초과·차이 금액을 적는다.',
        '3-5': `${excessTable(newViolations)}\n\n새 해외 일비 기준을 적용하면 한도 초과 신청은 모두 ${newViolations.length}건이다.`,
      },
    },
    rubric: {
      caseKey: CASE_KEY,
      axes: {
        judgment: {
          max: 30,
          rules: [
            { id: 'j3-choice', type: 'choice_answer', description: '3-1 부적절 자료 식별', subquestion: '3-1', scoring: 'per_option', points: 8 },
            { id: 'j3-no-confidential', type: 'pages_withheld', description: '규정 3쪽(대외비)을 AI에 전달하지 않음', material: POLICY_KEY, pages: ['page-3'], points: 8 },
            { id: 'j3-no-name', type: 'columns_withheld', description: '신청자 성명을 AI에 전달하지 않음', material: EXPENSES_KEY, columns: ['신청자'], points: 4 },
            { id: 'j3-needed', type: 'columns_sent', description: '판정에 필요한 직급·숙박비·일비·합계를 AI에 제공', material: EXPENSES_KEY, columns: ['직급', '숙박비', '일비', '합계'], minDistinctValues: 3, points: 6 },
            { id: 'j3-patterns', type: 'patterns_absent', description: '대화 본문에 주민등록번호·전화번호 형식이 없음', patterns: ['rrn', 'mobile'], points: 4 },
          ],
          criteria: [],
        },
        usage: {
          max: 35,
          rules: [
            { id: 'u3-revise', type: 'answer_revised_after_notice', description: '공지 전에 쓴 3-4 결재 의견서를 공지 이후 고쳐 다시 제출', notice: NOTICE_KEY, subquestion: '3-4', firstAnswerAfterNoticeCounts: false, points: 5 },
          ],
          criteria: [
            { id: 'u3-context', description: '규정의 필요한 부분(한도·정산·사전 승인)만 골라 AI에 제공하고 판단 기준을 분명히 전달했다', points: 8 },
            { id: 'u3-verify', description: 'AI의 한도 초과 판정과 금액 계산을 직접 다시 계산해 검증했다', points: 10 },
            { id: 'u3-fix', description: 'AI가 규정을 잘못 적용했을 때(직급 구분, 사전 승인 예외 등) 바로잡았다', points: 7 },
            { id: 'u3-change', description: '변경된 해외 일비 기준을 AI 작업과 결론에 반영했다', points: 5 },
          ],
        },
        output: {
          max: 35,
          rules: [
            { id: 'o3-violations', type: 'numeric_value', description: '한도 초과 신청 건수', subquestion: '3-2', label: '한도를 넘은 신청 건수(사전 승인 건 제외)', expected: oldViolations.length, tolerance: 0, points: 5 },
            { id: 'o3-sum-errors', type: 'numeric_value', description: '합계 계산이 틀린 신청 건수', subquestion: '3-3', label: '합계 계산이 틀린 신청 건수', expected: sumErrors.length, tolerance: 0, points: 5 },
            { id: 'o3-new-rule', type: 'numeric_value', description: '새 기준 적용 시 한도 초과 건수', subquestion: '3-5', label: '새 해외 일비 기준 적용 시 한도 초과 신청 건수', expected: newViolations.length, tolerance: 0, points: 5 },
          ],
          criteria: [
            { id: 'o3-table', description: '3-2 표의 신청번호, 초과 항목, 초과 금액이 정확하다', points: 8 },
            { id: 'o3-opinion', description: '3-4 결재 의견서가 반려 사유를 규정 조항과 이어 설명한다', points: 7 },
            { id: 'o3-exceptions', description: '사전 승인 예외를 올바르게 처리했다', points: 5 },
          ],
        },
      },
    },
  };
}
