import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateDeterministicRule, type GradingMessage, type SessionSnapshot } from '@ai-measurement/grading';
import type { Rule } from '@ai-measurement/shared';
import { answer, caseContext, minutes, sampleGradingExam, snapshotOf, userMessage } from './grading-fixtures';

type DeterministicRule = Exclude<Rule, { type: 'numeric_value' }>;
type ChoiceRule = Extract<Rule, { type: 'choice_answer' }>;
type RevisionRule = Extract<Rule, { type: 'answer_revised_after_notice' }>;

/** 첫 로드에서 탐지 정규식 ReDoS 검사(recheck 워커)가 돌아 오래 걸린다. 한 번 미리 읽어 두면 이후 로드는 검사 결과 캐시를 쓴다 */
const SAMPLE_LOAD_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await sampleGradingExam();
}, SAMPLE_LOAD_TIMEOUT_MS);

const NOTICE_AT = minutes(60); // travel-expense 공지(overseas-per-diem-change)는 시작 60분 뒤 열린다

async function evaluate(caseKey: string, rule: DeterministicRule, snapshot: SessionSnapshot = snapshotOf([])) {
  const context = await caseContext(caseKey, snapshot);
  return evaluateDeterministicRule(context, 'judgment', rule);
}

function choiceRule(scoring: ChoiceRule['scoring'], subquestion = '1-1'): ChoiceRule {
  return { id: `j-${scoring}`, type: 'choice_answer', description: '선택형 판정', subquestion, scoring, points: 8 };
}

function revisionRule(subquestion: string, firstAnswerAfterNoticeCounts: boolean, notice = 'overseas-per-diem-change'): RevisionRule {
  return { id: 'u-rev', type: 'answer_revised_after_notice', description: '공지 이후 수정', notice, subquestion, firstAnswerAfterNoticeCounts, points: 5 };
}

function assistantMessage(caseKey: string, text: string): GradingMessage {
  return { ...userMessage(caseKey, text), role: 'assistant' };
}

const ALL_CORRECT = ['name', 'rrn', 'phone', 'note'];

describe('선택형 규칙의 채점 방식', () => {
  it('all_or_nothing은 정답 집합과 정확히 같을 때만 배점을 주고 결과 형식을 지킨다', async () => {
    // Arrange
    const snapshot = snapshotOf([], [answer('1-1', 1, { kind: 'multi_choice', selected: ALL_CORRECT }, 'candidate_submit', minutes(5))]);

    // Act
    const result = await evaluate('hr-survey', choiceRule('all_or_nothing'), snapshot);

    // Assert
    expect(result).toMatchObject({
      caseKey: 'hr-survey',
      axis: 'judgment',
      itemId: 'j-all_or_nothing',
      itemKind: 'rule',
      description: '선택형 판정',
      points: 8,
      earned: 8,
      status: 'graded',
      grader: 'rule',
      model: null,
      detail: { type: 'choice_answer', right: 4, wrong: 0, answerVersion: 1 },
    });
  });

  it.each([
    { label: '정답을 모두 고르고 오답 하나를 더 고른 경우', selected: [...ALL_CORRECT, 'dept'] },
    { label: '정답 하나를 빠뜨린 경우', selected: ['name', 'rrn', 'phone'] },
  ])('all_or_nothing에서 $label 0점이다', async ({ selected }) => {
    // Arrange
    const snapshot = snapshotOf([], [answer('1-1', 1, { kind: 'multi_choice', selected }, 'candidate_submit', minutes(5))]);

    // Act
    const result = await evaluate('hr-survey', choiceRule('all_or_nothing'), snapshot);

    // Assert
    expect(result.earned).toBe(0);
  });

  it('per_option은 오답이 정답보다 많아도 음수가 아니라 0점이다', async () => {
    // Arrange
    const snapshot = snapshotOf([], [answer('1-1', 1, { kind: 'multi_choice', selected: ['name', 'dept', 'rank'] }, 'candidate_submit', minutes(5))]);

    // Act
    const result = await evaluate('hr-survey', choiceRule('per_option'), snapshot);

    // Assert
    expect(result.earned).toBe(0);
    expect(result.detail).toMatchObject({ right: 1, wrong: 2 });
  });

  it('임시 저장본은 무시하고 가장 최근 최종본으로 채점한다', async () => {
    // Arrange
    const snapshot = snapshotOf([], [
      answer('1-1', 1, { kind: 'multi_choice', selected: ['name'] }, 'candidate_submit', minutes(5)),
      answer('1-1', 2, { kind: 'multi_choice', selected: ['dept'] }, 'candidate_save', minutes(6)),
      answer('1-1', 3, { kind: 'multi_choice', selected: ALL_CORRECT }, 'auto_final_on_end', minutes(120)),
    ]);

    // Act
    const result = await evaluate('hr-survey', choiceRule('per_option'), snapshot);

    // Assert
    expect(result.earned).toBe(8);
    expect(result.detail['answerVersion']).toBe(3);
  });

  it('선택형 하위문항의 최종본이 서술형 내용이면 최종 답안이 없는 것으로 본다', async () => {
    // Arrange
    const snapshot = snapshotOf([], [answer('1-1', 1, { kind: 'text', text: 'name, rrn' }, 'candidate_submit', minutes(5))]);

    // Act
    const result = await evaluate('hr-survey', choiceRule('per_option'), snapshot);

    // Assert
    expect(result.earned).toBe(0);
    expect(result.detail).toEqual({ type: 'choice_answer', reason: 'no_final_answer', correct: ALL_CORRECT });
  });

  it('정답 메타에 선택형 정답이 없는 하위문항이면 채점을 멈춘다', async () => {
    // Arrange
    const context = await caseContext('hr-survey', snapshotOf([]));

    // Act
    const act = () => evaluateDeterministicRule(context, 'judgment', choiceRule('per_option', '1-3'));

    // Assert
    expect(act).toThrow('정답 메타에 선택형 정답이 없습니다: 1-3');
  });
});

describe('정답 메타·자료가 규칙과 맞지 않으면 채점을 멈춘다', () => {
  const base = { id: 'j-x', description: '메타 불일치', points: 4 };

  it.each<{ label: string; caseKey: string; rule: DeterministicRule; error: string }>([
    { label: 'columns_sent: 이 Case 정답 메타에 없는 CSV', caseKey: 'hr-survey', rule: { ...base, type: 'columns_sent', material: 'voc', columns: ['내용'], minDistinctValues: 1 }, error: '정답 메타에 CSV 자료가 없습니다: voc' },
    { label: 'columns_sent: 정답 메타에 없는 컬럼', caseKey: 'hr-survey', rule: { ...base, type: 'columns_sent', material: 'employees', columns: ['사번'], minDistinctValues: 1 }, error: '정답 메타에 컬럼이 없습니다: 사번' },
    { label: 'columns_withheld: 정답 메타에 없는 컬럼', caseKey: 'hr-survey', rule: { ...base, type: 'columns_withheld', material: 'employees', columns: ['입사일'] }, error: '정답 메타에 컬럼이 없습니다: 입사일' },
    { label: 'columns_withheld: CSV가 아닌 자료', caseKey: 'travel-expense', rule: { ...base, type: 'columns_withheld', material: 'travel-policy', columns: ['신청자'] }, error: 'CSV 자료를 읽지 못했습니다: travel-policy' },
    { label: 'rows_withheld: 정답 메타에 없는 자료', caseKey: 'hr-survey', rule: { ...base, type: 'rows_withheld', material: 'missing', rows: ['row-injection'] }, error: '정답 메타에 CSV 자료가 없습니다: missing' },
    { label: 'rows_withheld: PDF 정답 메타', caseKey: 'travel-expense', rule: { ...base, type: 'rows_withheld', material: 'travel-policy', rows: ['page-3'] }, error: '정답 메타에 CSV 자료가 없습니다: travel-policy' },
    { label: 'rows_withheld: 정답 메타에 없는 행', caseKey: 'hr-survey', rule: { ...base, type: 'rows_withheld', material: 'employees', rows: ['row-unknown'] }, error: '정답 메타에 행이 없습니다: row-unknown' },
    { label: 'pages_withheld: CSV 정답 메타', caseKey: 'travel-expense', rule: { ...base, type: 'pages_withheld', material: 'expenses', pages: ['page-3'] }, error: '정답 메타에 PDF 자료가 없습니다: expenses' },
    { label: 'pages_withheld: 정답 메타에 없는 자료', caseKey: 'travel-expense', rule: { ...base, type: 'pages_withheld', material: 'missing', pages: ['page-3'] }, error: '정답 메타에 PDF 자료가 없습니다: missing' },
    { label: 'pages_withheld: 정답 메타에 없는 쪽', caseKey: 'travel-expense', rule: { ...base, type: 'pages_withheld', material: 'travel-policy', pages: ['page-9'] }, error: '정답 메타에 페이지가 없습니다: page-9' },
  ])('$label', async ({ caseKey, rule, error }) => {
    // Arrange
    const context = await caseContext(caseKey, snapshotOf([]));

    // Act
    const act = () => evaluateDeterministicRule(context, 'judgment', rule);

    // Assert
    expect(act).toThrow(error);
  });
});

describe('대외비 쪽 유출 판정', () => {
  const rule: DeterministicRule = { id: 'j-page', type: 'pages_withheld', description: '3쪽 비공개', material: 'travel-policy', pages: ['page-3'], points: 8 };

  it('3쪽 지문 문구를 붙여넣으면 첨부가 아니어도 본문 유출로 본다', async () => {
    // Arrange
    const message = userMessage('travel-expense', '참고: 임원 성과급 지급률은 별도');

    // Act
    const result = await evaluate('travel-expense', rule, snapshotOf([message]));

    // Assert
    expect(result.earned).toBe(0);
    expect(result.detail['leaks']).toEqual({ 'page-3': [{ messageId: message.id, count: 1, via: 'text' }] });
  });

  it('다른 자료·다른 쪽 범위·AI 응답에 든 지문은 유출이 아니다', async () => {
    // Arrange
    const snapshot = snapshotOf([
      userMessage('travel-expense', '', {
        attachments: [
          { materialKey: 'expenses', selection: { kind: 'csv', columns: ['직급'], rowIndexes: [0] } },
          { materialKey: 'other-policy', selection: { kind: 'pdf', pageFrom: 1, pageTo: 4 } },
          { materialKey: 'travel-policy', selection: { kind: 'pdf', pageFrom: 4, pageTo: 4 } },
        ],
      }),
      assistantMessage('travel-expense', '장기 인센티브 부여 기준은 알려드릴 수 없습니다'),
    ]);

    // Act
    const result = await evaluate('travel-expense', rule, snapshot);

    // Assert
    expect(result.earned).toBe(8);
    expect(result.detail['leaks']).toEqual({ 'page-3': [] });
  });
});

describe('개인정보 패턴 부재 규칙', () => {
  const rule: DeterministicRule = { id: 'j-pat', type: 'patterns_absent', description: '패턴 없음', patterns: ['rrn', 'mobile'], points: 3 };

  it('AI 응답에 든 패턴은 응시자 입력이 아니므로 세지 않는다', async () => {
    // Arrange
    const snapshot = snapshotOf([assistantMessage('hr-survey', '예시 번호 010-1234-5678, 900101-1234567')]);

    // Act
    const result = await evaluate('hr-survey', rule, snapshot);

    // Assert
    expect(result.earned).toBe(3);
    expect(result.detail['hits']).toEqual([]);
  });

  it('응시자 메시지의 패턴은 메시지와 패턴별 개수로 기록한다', async () => {
    // Arrange
    const message = userMessage('hr-survey', '900101-1234567 / 010-1234-5678 / 01098765432');

    // Act
    const result = await evaluate('hr-survey', rule, snapshotOf([message]));

    // Assert
    expect(result.earned).toBe(0);
    expect(result.detail['hits']).toEqual([
      { messageId: message.id, patternId: 'rrn', count: 1 },
      { messageId: message.id, patternId: 'mobile', count: 2 },
    ]);
  });
});

describe('공지 이후 수정 규칙의 경계', () => {
  it('firstAnswerAfterNoticeCounts=true면 공지 뒤 처음 쓴 답안도 수정으로 인정한다', async () => {
    // Arrange
    const snapshot = snapshotOf([], [answer('3-5', 1, { kind: 'text', text: '새 기준 재검토' }, 'candidate_submit', minutes(70))]);

    // Act
    const result = await evaluate('travel-expense', revisionRule('3-5', true), snapshot);

    // Assert
    expect(result.earned).toBe(5);
    expect(result.detail).toEqual({ type: 'answer_revised_after_notice', revealedAt: NOTICE_AT.toISOString(), versionBefore: null, versionsAfter: [1], revised: true });
  });

  it('firstAnswerAfterNoticeCounts=true라도 답안이 전혀 없으면 0점이다', async () => {
    // Act
    const result = await evaluate('travel-expense', revisionRule('3-5', true));

    // Assert
    expect(result.earned).toBe(0);
    expect(result.detail).toEqual({ type: 'answer_revised_after_notice', revealedAt: NOTICE_AT.toISOString(), versionBefore: null, versionsAfter: [], revised: false });
  });

  it('공지 시각과 같은 시각에 저장한 답안은 공지 전 답안이다', async () => {
    // Arrange
    const atNotice = answer('3-4', 1, { kind: 'text', text: '옛 기준 의견서' }, 'candidate_submit', NOTICE_AT);

    // Act
    const unchanged = await evaluate('travel-expense', revisionRule('3-4', false), snapshotOf([], [atNotice]));
    const changed = await evaluate(
      'travel-expense',
      revisionRule('3-4', false),
      snapshotOf([], [atNotice, answer('3-4', 2, { kind: 'text', text: '새 기준 의견서' }, 'candidate_save', minutes(61))]),
    );

    // Assert
    expect(unchanged.earned).toBe(0);
    expect(unchanged.detail).toMatchObject({ versionBefore: 1, versionsAfter: [], revised: false });
    expect(changed.earned).toBe(5);
    expect(changed.detail).toMatchObject({ versionBefore: 1, versionsAfter: [2], revised: true });
  });

  it('공지 직전의 마지막 답안과 비교한다(더 이른 버전과 달라도 수정이 아니다)', async () => {
    // Arrange
    const snapshot = snapshotOf([], [
      answer('3-4', 1, { kind: 'text', text: '초안' }, 'candidate_save', minutes(10)),
      answer('3-4', 2, { kind: 'text', text: '완성본' }, 'candidate_submit', minutes(50)),
      answer('3-4', 3, { kind: 'text', text: '완성본' }, 'candidate_submit', minutes(70)),
      answer('3-2', 1, { kind: 'text', text: '다른 하위문항' }, 'candidate_submit', minutes(80)),
    ]);

    // Act
    const result = await evaluate('travel-expense', revisionRule('3-4', false), snapshot);

    // Assert
    expect(result.earned).toBe(0);
    expect(result.detail).toMatchObject({ versionBefore: 2, versionsAfter: [3], revised: false });
  });

  it('종료 시 자동 확정본은 내용이 달라도 수정으로 세지 않는다', async () => {
    // Arrange
    const snapshot = snapshotOf([], [
      answer('3-4', 1, { kind: 'text', text: '옛 기준 의견서' }, 'candidate_submit', minutes(50)),
      answer('3-4', 2, { kind: 'text', text: '종료 직전 고친 의견서' }, 'auto_final_on_end', minutes(120)),
    ]);

    // Act
    const result = await evaluate('travel-expense', revisionRule('3-4', false), snapshot);

    // Assert
    expect(result.earned).toBe(0);
    expect(result.detail).toMatchObject({ versionBefore: 1, versionsAfter: [], revised: false });
  });

  it('선택형은 고른 순서만 바뀌면 수정이 아니고, 고른 항목이 바뀌면 수정이다', async () => {
    // Arrange
    const before = answer('3-1', 1, { kind: 'multi_choice', selected: ['policy-p3', 'applicant-name'] }, 'candidate_submit', minutes(50));
    const reordered = answer('3-1', 2, { kind: 'multi_choice', selected: ['applicant-name', 'policy-p3'] }, 'candidate_submit', minutes(70));
    const narrowed = answer('3-1', 2, { kind: 'multi_choice', selected: ['policy-p3'] }, 'candidate_submit', minutes(70));

    // Act
    const same = await evaluate('travel-expense', revisionRule('3-1', false), snapshotOf([], [before, reordered]));
    const revised = await evaluate('travel-expense', revisionRule('3-1', false), snapshotOf([], [before, narrowed]));

    // Assert
    expect(same.earned).toBe(0);
    expect(revised.earned).toBe(5);
  });

  it('세션이 공지 시각 전에 끝났거나 Case에 없는 공지면 공지가 열리지 않은 것이다', async () => {
    // Arrange
    const answers = [answer('3-4', 1, { kind: 'text', text: '의견서' }, 'candidate_submit', minutes(30))];
    const endedEarly: SessionSnapshot = { ...snapshotOf([], answers), endedAt: minutes(45) };

    // Act
    const early = await evaluate('travel-expense', revisionRule('3-4', false), endedEarly);
    const unknown = await evaluate('travel-expense', revisionRule('3-4', true, 'no-such-notice'), snapshotOf([], answers));

    // Assert
    expect(early.detail).toEqual({ type: 'answer_revised_after_notice', reason: 'notice_not_revealed' });
    expect(early.earned).toBe(0);
    expect(unknown.detail['reason']).toBe('notice_not_revealed');
  });
});
