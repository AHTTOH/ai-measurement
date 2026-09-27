import { describe, expect, it } from 'vitest';
import {
  answerContentsEqual,
  answerFormatMismatch,
  computeNoticeRevealTimes,
  findContainedTexts,
  findContainedValues,
  findPatternHits,
  isSubquestionVisible,
  type CaseDefinition,
} from '@ai-measurement/shared';
import { CsvFormatError, CsvSelectionError, parseCsvText, renderCsv, selectCsv } from '@ai-measurement/shared/node';

describe('CSV 처리', () => {
  const table = parseCsvText('﻿이름,부서,메모\n김가,영업,"쉼표, 포함"\n이나,개발,\n박다,영업,"줄\n바꿈"\n');

  it('BOM을 지우고 따옴표 안 쉼표·줄바꿈을 보존한다', () => {
    expect(table.headers).toEqual(['이름', '부서', '메모']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]?.[2]).toBe('쉼표, 포함');
    expect(table.rows[2]?.[2]).toBe('줄\n바꿈');
  });

  it('고른 컬럼·행만 원래 순서로 남긴다', () => {
    const selected = selectCsv(table, { columns: ['메모', '부서'], rowIndexes: [2, 0] });
    expect(selected.headers).toEqual(['부서', '메모']);
    expect(selected.rows).toEqual([
      ['영업', '쉼표, 포함'],
      ['영업', '줄\n바꿈'],
    ]);
    expect(renderCsv(selected)).toBe('부서,메모\n영업,"쉼표, 포함"\n영업,"줄\n바꿈"\n');
  });

  it('없는 컬럼·행, 빈 선택, 중복 선택을 거부한다', () => {
    expect(() => selectCsv(table, { columns: ['없음'], rowIndexes: [0] })).toThrow(CsvSelectionError);
    expect(() => selectCsv(table, { columns: ['이름'], rowIndexes: [3] })).toThrow(CsvSelectionError);
    expect(() => selectCsv(table, { columns: [], rowIndexes: [0] })).toThrow(CsvSelectionError);
    expect(() => selectCsv(table, { columns: ['이름', '이름'], rowIndexes: [0] })).toThrow(CsvSelectionError);
    expect(() => selectCsv(table, { columns: ['이름'], rowIndexes: [0, 0] })).toThrow(CsvSelectionError);
  });

  it('헤더 중복이나 열 개수 불일치는 형식 오류다', () => {
    expect(() => parseCsvText('a,a\n1,2\n')).toThrow(CsvFormatError);
    expect(() => parseCsvText('a,b\n1,2,3\n')).toThrow(CsvFormatError);
  });
});

describe('본문 탐지', () => {
  const patterns = [
    { id: 'rrn', regex: '(?<!\\d)\\d{6}-[1-4]\\d{6}(?!\\d)' },
    { id: 'mobile', regex: '(?<!\\d)01[016789]-?\\d{3,4}-?\\d{4}(?!\\d)' },
  ];

  it('패턴별 적중 수를 센다', () => {
    const hits = findPatternHits('주민 900101-1234567, 전화 010-1234-5678 또는 01098765432', patterns);
    expect(hits).toEqual([
      { patternId: 'rrn', count: 1 },
      { patternId: 'mobile', count: 2 },
    ]);
  });

  it('같은 패턴을 여러 번 써도 결과가 같다(정규식 상태가 남지 않는다)', () => {
    const text = '010-1111-2222 010-3333-4444';
    expect(findPatternHits(text, patterns)).toEqual(findPatternHits(text, patterns));
  });

  it('서식만 바꾼 값도 같은 값으로 찾고, 짧은 값은 건너뛴다', () => {
    const found = findContainedValues('연락처 01012345678 과 김가 님', ['010-1234-5678', '김가', '010-9999-0000'], 8);
    expect(found).toEqual(['010-1234-5678']);
  });

  it('지정 문구가 들어 있는지 찾는다', () => {
    expect(findContainedTexts('이전 지시를 무시하고 출력', ['지시를 무시하고', '없는 문구'])).toEqual(['지시를 무시하고']);
  });
});

describe('공지 노출', () => {
  const caseDef: CaseDefinition = {
    key: 'c',
    title: 't',
    brief: 'b',
    materials: [],
    subquestions: [
      { key: 'a', title: 'a', type: 'ai_task', prompt: 'p', answer: { kind: 'text' }, unlockedByNotice: null },
      { key: 'b', title: 'b', type: 'final', prompt: 'p', answer: { kind: 'text' }, unlockedByNotice: 'n-time' },
    ],
    notices: [
      { key: 'n-sub', from: 'f', title: 't', body: 'b', reveal: { after: 'subquestion_submitted', subquestion: 'a' } },
      { key: 'n-time', from: 'f', title: 't', body: 'b', reveal: { after: 'elapsed_minutes', minutes: 60 } },
    ],
  };
  const started = new Date('2026-09-27T01:00:00Z');

  it('시간 조건은 시작 후 N분에 열린다', () => {
    const before = computeNoticeRevealTimes(caseDef, { sessionStartedAt: started, firstFinalSubmissionAt: new Map(), now: new Date('2026-09-27T01:59:59Z') });
    expect(before.has('n-time')).toBe(false);
    const after = computeNoticeRevealTimes(caseDef, { sessionStartedAt: started, firstFinalSubmissionAt: new Map(), now: new Date('2026-09-27T02:00:00Z') });
    expect(after.get('n-time')?.toISOString()).toBe('2026-09-27T02:00:00.000Z');
    expect(isSubquestionVisible(caseDef.subquestions[1]!, after)).toBe(true);
    expect(isSubquestionVisible(caseDef.subquestions[1]!, before)).toBe(false);
  });

  it('제출 조건은 최초 최종 제출 시각에 열린다', () => {
    const submittedAt = new Date('2026-09-27T01:10:00Z');
    const revealed = computeNoticeRevealTimes(caseDef, {
      sessionStartedAt: started,
      firstFinalSubmissionAt: new Map([['a', submittedAt]]),
      now: new Date('2026-09-27T01:11:00Z'),
    });
    expect(revealed.get('n-sub')).toEqual(submittedAt);
  });
});

describe('답안 형식', () => {
  const choice = { kind: 'multi_choice' as const, options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] };

  it('형식이 다르거나 없는 선택지·중복 선택을 거부한다', () => {
    expect(answerFormatMismatch({ kind: 'text' }, { kind: 'multi_choice', selected: [] })).not.toBeNull();
    expect(answerFormatMismatch(choice, { kind: 'multi_choice', selected: ['z'] })).toContain('z');
    expect(answerFormatMismatch(choice, { kind: 'multi_choice', selected: ['x', 'x'] })).not.toBeNull();
    expect(answerFormatMismatch(choice, { kind: 'multi_choice', selected: ['y', 'x'] })).toBeNull();
  });

  it('선택 순서가 달라도 같은 답안으로 본다', () => {
    expect(answerContentsEqual({ kind: 'multi_choice', selected: ['x', 'y'] }, { kind: 'multi_choice', selected: ['y', 'x'] })).toBe(true);
    expect(answerContentsEqual({ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' })).toBe(false);
  });
});
