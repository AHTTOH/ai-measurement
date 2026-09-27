import { describe, expect, it } from 'vitest';
import { outputMismatch, parseGradingText, type LlmGradingOutput, type LlmItemsSpec } from '@ai-measurement/grading';

const ITEMS: LlmItemsSpec = {
  criteria: [
    { id: 'c1', axis: 'usage', description: '검증', points: 5 },
    { id: 'c2', axis: 'output', description: '완성도', points: 3 },
  ],
  numeric: [
    { id: 'n1', subquestion: '1-3', label: '평균' },
    { id: 'n2', subquestion: '1-3', label: '비율' },
  ],
};

type CriterionOutput = LlmGradingOutput['criteria'][number];
type NumericOutput = LlmGradingOutput['numeric'][number];

function criterion(id: string, score: number): CriterionOutput {
  return { id, score, rationale: '근거', evidence: ['M1'] };
}

function numeric(id: string, reportedValue: number | null = 1): NumericOutput {
  return { id, reportedValue, quote: String(reportedValue) };
}

function output(criteria: CriterionOutput[], numerics: NumericOutput[]): LlmGradingOutput {
  return { criteria, numeric: numerics };
}

const VALID = output([criterion('c1', 5), criterion('c2', 0)], [numeric('n1'), numeric('n2', null)]);

describe('LLM 결과와 채점 항목 대조(outputMismatch)', () => {
  it('모든 항목이 한 번씩 있고 점수가 0~배점이면 문제없다(경계값 포함)', () => {
    // Act
    const mismatch = outputMismatch(VALID, ITEMS);

    // Assert
    expect(mismatch).toBeNull();
  });

  it('LLM에 맡길 항목이 없고 결과도 비었으면 문제없다', () => {
    // Act
    const mismatch = outputMismatch(output([], []), { criteria: [], numeric: [] });

    // Assert
    expect(mismatch).toBeNull();
  });

  it.each<{ label: string; given: LlmGradingOutput; reason: string }>([
    { label: '모르는 기준 id', given: output([criterion('c1', 1), criterion('c2', 1), criterion('c9', 1)], [numeric('n1'), numeric('n2')]), reason: '모르는 기준 id: c9' },
    { label: '같은 기준이 두 번', given: output([criterion('c1', 1), criterion('c1', 2), criterion('c2', 1)], [numeric('n1'), numeric('n2')]), reason: '중복된 기준 id: c1' },
    { label: '음수 점수', given: output([criterion('c1', -1), criterion('c2', 1)], [numeric('n1'), numeric('n2')]), reason: '기준 c1 점수 -1가 0~5 범위를 벗어납니다' },
    { label: '배점 초과', given: output([criterion('c1', 1), criterion('c2', 3.5)], [numeric('n1'), numeric('n2')]), reason: '기준 c2 점수 3.5가 0~3 범위를 벗어납니다' },
    { label: 'NaN 점수', given: output([criterion('c1', Number.NaN), criterion('c2', 1)], [numeric('n1'), numeric('n2')]), reason: '기준 c1 점수 NaN가 0~5 범위를 벗어납니다' },
    { label: '무한대 점수', given: output([criterion('c1', Number.POSITIVE_INFINITY), criterion('c2', 1)], [numeric('n1'), numeric('n2')]), reason: '기준 c1 점수 Infinity가 0~5 범위를 벗어납니다' },
    { label: '빠진 기준', given: output([criterion('c2', 1)], [numeric('n1'), numeric('n2')]), reason: '빠진 기준이 있습니다(2개 중 1개)' },
    { label: '같은 수치 항목이 두 번', given: output([criterion('c1', 1), criterion('c2', 1)], [numeric('n1'), numeric('n1'), numeric('n2')]), reason: '중복된 수치 항목이 있습니다' },
    { label: '모르는 수치 항목', given: output([criterion('c1', 1), criterion('c2', 1)], [numeric('n1'), numeric('n9')]), reason: '모르는 수치 항목: n9' },
    { label: '빠진 수치 항목', given: output([criterion('c1', 1), criterion('c2', 1)], [numeric('n2')]), reason: '빠진 수치 항목이 있습니다' },
  ])('$label: 대조 사유를 돌려준다', ({ given, reason }) => {
    // Act
    const mismatch = outputMismatch(given, ITEMS);

    // Assert
    expect(mismatch).toBe(reason);
  });
});

describe('채점 응답 텍스트 해석(parseGradingText)', () => {
  it('형식과 항목이 맞으면 해석한 결과를 그대로 돌려준다', () => {
    // Act
    const parsed = parseGradingText(JSON.stringify(VALID), ITEMS);

    // Assert
    expect(parsed).toEqual({ ok: true, output: VALID });
  });

  it.each<{ label: string; body: unknown }>([
    { label: 'numeric 필드가 없음', body: { criteria: [criterion('c1', 1)] } },
    { label: '정의에 없는 최상위 필드', body: { ...VALID, summary: '총평' } },
    { label: '근거가 배열이 아님', body: { criteria: [{ ...criterion('c1', 1), evidence: 'M1' }], numeric: [] } },
    { label: '기준 항목에 모르는 필드', body: { criteria: [{ ...criterion('c1', 1), confidence: 0.9 }], numeric: [] } },
    { label: '보고 수치가 문자열', body: { criteria: [], numeric: [{ id: 'n1', reportedValue: '3.08', quote: '3.08' }] } },
    { label: '점수가 문자열', body: { criteria: [{ ...criterion('c1', 1), score: '5' }], numeric: [] } },
    { label: '최상위가 배열', body: [VALID] },
    { label: '최상위가 null', body: null },
  ])('$label: 형식 오류로 돌려준다', ({ body }) => {
    // Act
    const parsed = parseGradingText(JSON.stringify(body), ITEMS);

    // Assert
    expect(parsed).toEqual({ ok: false, error: expect.stringMatching(/^채점 응답 형식 오류: .+/u) });
  });

  it('형식은 맞지만 항목이 어긋나면 대조 사유를 돌려준다', () => {
    // Arrange
    const text = JSON.stringify(output([criterion('c1', 1), criterion('c2', 1)], [numeric('n1')]));

    // Act
    const parsed = parseGradingText(text, ITEMS);

    // Assert
    expect(parsed).toEqual({ ok: false, error: '빠진 수치 항목이 있습니다' });
  });

  it.each(['', '{"criteria": [', '```json\n{}\n```'])('JSON이 아닌 응답(%j)은 원인 메시지와 함께 실패한다', (text) => {
    // Act
    const parsed = parseGradingText(text, ITEMS);

    // Assert
    expect(parsed).toEqual({ ok: false, error: expect.stringMatching(/^채점 응답이 JSON이 아닙니다: .+/u) });
  });
});
