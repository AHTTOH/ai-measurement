import { beforeAll, describe, expect, it } from 'vitest';
import {
  completeSession,
  prepareSession,
  type GradingMessage,
  type ItemResult,
  type LlmGradingOutput,
  type LlmGradingResult,
  type LlmItemsSpec,
  type PreparedSession,
} from '@ai-measurement/grading';
import { sampleGradingExam, snapshotOf, userMessage } from './grading-fixtures';

/**
 * llmItemResults는 completeSession을 거쳐 검증한다(패키지 공개 경로).
 * 결과 형식 검증(parseGradingText)을 통과하지 못할 결과도 넣어, 방어 분기가 미채점으로 드러내는지 본다.
 */

const MODEL = 'claude-test-model';

/** 첫 로드에서 탐지 정규식 ReDoS 검사(recheck 워커)가 돌아 오래 걸린다. 한 번 미리 읽어 두면 이후 로드는 검사 결과 캐시를 쓴다 */
const SAMPLE_LOAD_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await sampleGradingExam();
}, SAMPLE_LOAD_TIMEOUT_MS);

async function prepare(messages: GradingMessage[] = []): Promise<PreparedSession> {
  const { exam, materials } = await sampleGradingExam();
  return prepareSession(exam, materials, snapshotOf(messages));
}

function itemsOf(prepared: PreparedSession, caseKey: string): LlmItemsSpec {
  const llm = prepared.cases.find((c) => c.context.caseDef.key === caseKey)?.llm;
  if (llm === undefined || llm === null) throw new Error(`LLM 재료가 없습니다: ${caseKey}`);
  return llm.items;
}

/** 모든 기준에 만점, 모든 수치는 찾지 못함(null) */
function fullOutput(items: LlmItemsSpec): LlmGradingOutput {
  return {
    criteria: items.criteria.map((c) => ({ id: c.id, score: c.points, rationale: `${c.id} 근거`, evidence: [] })),
    numeric: items.numeric.map((n) => ({ id: n.id, reportedValue: null, quote: '' })),
  };
}

function ok(output: LlmGradingOutput): LlmGradingResult {
  return { customId: 'r1', ok: true, output, model: MODEL };
}

function gradeCase(prepared: PreparedSession, caseKey: string, result: LlmGradingResult): ItemResult[] {
  return completeSession(prepared, (key) => (key === caseKey ? result : undefined), 'llm').filter((i) => i.caseKey === caseKey && i.grader === 'llm');
}

function itemById(items: readonly ItemResult[], itemId: string): ItemResult {
  const found = items.find((i) => i.itemId === itemId);
  if (found === undefined) throw new Error(`항목이 없습니다: ${itemId}`);
  return found;
}

describe('LLM 결과를 항목 점수로 바꾸기', () => {
  it('실패한 결과면 기준·수치 항목을 모두 미채점으로 두고 실패 사유를 남긴다', async () => {
    // Arrange
    const prepared = await prepare();
    const failed: LlmGradingResult = { customId: 'r1', ok: false, error: '채점 응답 형식 오류: 필드 누락' };

    // Act
    const items = gradeCase(prepared, 'hr-survey', failed);

    // Assert
    const criterion = { status: 'ungraded', earned: null, model: null, itemKind: 'criterion', detail: { error: failed.error } };
    const numeric = { status: 'ungraded', earned: null, model: null, itemKind: 'rule', detail: { type: 'numeric_value', error: failed.error } };
    expect(items).toMatchObject([...Array.from({ length: 8 }, () => criterion), numeric, numeric]);
    expect(items.map((i) => i.itemId).slice(-2)).toEqual(['o-sales1-sat', 'o-overall-turnover']);
  });

  it('결과에 빠진 기준·수치 항목만 미채점으로 두고 나머지는 채점한다', async () => {
    // Arrange
    const prepared = await prepare();
    const full = fullOutput(itemsOf(prepared, 'hr-survey'));
    const partial: LlmGradingOutput = {
      criteria: full.criteria.filter((c) => c.id !== 'u-verify'),
      numeric: full.numeric.filter((n) => n.id !== 'o-overall-turnover'),
    };

    // Act
    const items = gradeCase(prepared, 'hr-survey', ok(partial));

    // Assert
    expect(itemById(items, 'u-verify')).toMatchObject({ status: 'ungraded', earned: null, model: MODEL, detail: { error: '결과에 이 기준이 없습니다' } });
    expect(itemById(items, 'o-overall-turnover')).toMatchObject({
      status: 'ungraded',
      earned: null,
      model: MODEL,
      detail: { type: 'numeric_value', error: '결과에 이 수치 항목이 없습니다' },
    });
    expect(itemById(items, 'u-context')).toMatchObject({ status: 'graded', earned: 8, points: 8, axis: 'usage', model: MODEL, grader: 'llm' });
    expect(itemById(items, 'o-sales1-sat')).toMatchObject({ status: 'graded', earned: 0, model: MODEL, detail: { reportedValue: null } });
  });

  it('근거 중 이 Case 대화의 메시지 번호만 DB id로 옮기고, 원래 근거 목록은 그대로 남긴다', async () => {
    // Arrange
    const first = userMessage('hr-survey', '부서별 평균을 구해줘');
    const second = userMessage('hr-survey', '비율 분모를 다시 확인해줘');
    const prepared = await prepare([first, userMessage('customer-voc', '다른 Case'), second]);
    const full = fullOutput(itemsOf(prepared, 'hr-survey'));
    const evidence = ['M2', 'M9', 'A:1-3@v1', 'M1'];
    const output: LlmGradingOutput = {
      ...full,
      criteria: full.criteria.map((c) => (c.id === 'u-iterate' ? { ...c, score: 3.5, rationale: '재요청 확인', evidence } : c)),
    };

    // Act
    const items = gradeCase(prepared, 'hr-survey', ok(output));

    // Assert
    expect(itemById(items, 'u-iterate')).toMatchObject({
      earned: 3.5,
      status: 'graded',
      detail: { rationale: '재요청 확인', evidence, evidenceMessageIds: [second.id, first.id] },
    });
    expect(itemById(items, 'u-context').detail).toEqual({ rationale: 'u-context 근거', evidence: [], evidenceMessageIds: [] });
  });

  it.each<{ caseKey: string; itemId: string; reportedValue: number | null; earned: number; expected: number; tolerance: number }>([
    { caseKey: 'customer-voc', itemId: 'o2-delivery', reportedValue: 14, earned: 5, expected: 13, tolerance: 1 },
    { caseKey: 'customer-voc', itemId: 'o2-delivery', reportedValue: 12, earned: 5, expected: 13, tolerance: 1 },
    { caseKey: 'customer-voc', itemId: 'o2-delivery', reportedValue: 15, earned: 0, expected: 13, tolerance: 1 },
    { caseKey: 'customer-voc', itemId: 'o2-refund', reportedValue: null, earned: 0, expected: 8, tolerance: 1 },
    { caseKey: 'travel-expense', itemId: 'o3-violations', reportedValue: 7, earned: 5, expected: 7, tolerance: 0 },
    { caseKey: 'travel-expense', itemId: 'o3-violations', reportedValue: 7.5, earned: 0, expected: 7, tolerance: 0 },
    { caseKey: 'hr-survey', itemId: 'o-sales1-sat', reportedValue: 3.08, earned: 5, expected: 3.0833, tolerance: 0.05 },
  ])('$itemId: 보고값 $reportedValue (기준 $expected, 허용오차 $tolerance) 이면 $earned 점', async ({ caseKey, itemId, reportedValue, earned, expected, tolerance }) => {
    // Arrange
    const prepared = await prepare();
    const full = fullOutput(itemsOf(prepared, caseKey));
    const quote = `답안에 적힌 값 ${String(reportedValue)}`;
    const output: LlmGradingOutput = { ...full, numeric: full.numeric.map((n) => (n.id === itemId ? { id: n.id, reportedValue, quote } : n)) };

    // Act
    const items = gradeCase(prepared, caseKey, ok(output));

    // Assert
    expect(itemById(items, itemId)).toMatchObject({
      itemKind: 'rule',
      axis: 'output',
      points: 5,
      earned,
      status: 'graded',
      grader: 'llm',
      model: MODEL,
      detail: { type: 'numeric_value', expected, tolerance, reportedValue, quote },
    });
  });
});
