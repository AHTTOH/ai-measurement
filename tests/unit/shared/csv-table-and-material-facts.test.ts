import { describe, expect, it } from 'vitest';
import { distinctColumnValues, findCsvRowIndexes, type CsvTable } from '@ai-measurement/shared';
import { CsvFormatError, CsvSelectionError, parseCsvText, selectCsv } from '@ai-measurement/shared/node';

describe('CSV 해석 오류', () => {
  it.each([
    ['빈 문자열', ''],
    ['빈 줄만 있는 문자열', '\n\n'],
  ])('%s은 헤더 행이 없다고 거부한다', (_label, text) => {
    // Arrange, Act
    const parse = () => parseCsvText(text);

    // Assert
    expect(parse).toThrow(CsvFormatError);
    expect(parse).toThrow('CSV에 헤더 행이 없습니다');
  });

  it('공백뿐인 헤더는 빈 헤더로 거부한다', () => {
    // Arrange, Act
    const parse = () => parseCsvText('이름, ,부서\n김가,x,영업\n');

    // Assert
    expect(parse).toThrow(CsvFormatError);
    expect(parse).toThrow('빈 헤더가 있습니다');
  });

  it('닫히지 않은 따옴표는 해석 오류로 감싸서 던진다', () => {
    // Arrange, Act
    const parse = () => parseCsvText('이름,메모\n김가,"닫히지 않음\n');

    // Assert
    expect(parse).toThrow(CsvFormatError);
    expect(parse).toThrow(/^CSV를 해석할 수 없습니다: /u);
  });

  it('헤더 앞뒤 공백은 지우고 셀 값은 그대로 둔다', () => {
    // Arrange
    const text = ' 이름 , 부서 \n 김가 ,영업\n';

    // Act
    const table = parseCsvText(text);

    // Assert
    expect(table).toEqual({ headers: ['이름', '부서'], rows: [[' 김가 ', '영업']] });
  });
});

describe('CSV 선택 오류', () => {
  const table: CsvTable = { headers: ['이름', '부서'], rows: [['김가', '영업'], ['이나', '개발']] };

  it('행을 하나도 고르지 않으면 거부한다', () => {
    // Arrange, Act
    const select = () => selectCsv(table, { columns: ['이름'], rowIndexes: [] });

    // Assert
    expect(select).toThrow(CsvSelectionError);
    expect(select).toThrow('행을 하나 이상 골라야 합니다');
  });

  it.each([
    ['소수', 0.5],
    ['음수', -1],
    ['행 개수와 같은 번호', 2],
  ])('행 번호가 %s면 거부한다', (_label, index) => {
    // Arrange, Act
    const select = () => selectCsv(table, { columns: ['이름'], rowIndexes: [index] });

    // Assert
    expect(select).toThrow(CsvSelectionError);
    expect(select).toThrow(`없는 행 번호입니다: ${index}`);
  });
});

describe('자료 사실: 행 찾기', () => {
  const table: CsvTable = {
    headers: ['사번', '부서'],
    rows: [
      ['E1', '영업'],
      ['E2', '개발'],
      ['E3', '영업'],
    ],
  };

  it('값이 정확히 같은 행의 인덱스를 모두 돌려준다', () => {
    // Arrange, Act
    const matches = findCsvRowIndexes(table, '부서', '영업');

    // Assert
    expect(matches).toEqual([0, 2]);
  });

  it('앞뒤 공백이 다른 값은 같은 값으로 보지 않는다', () => {
    // Arrange, Act
    const matches = findCsvRowIndexes(table, '부서', ' 영업');

    // Assert
    expect(matches).toEqual([]);
  });

  it('없는 컬럼이면 빈 목록이다', () => {
    // Arrange, Act
    const matches = findCsvRowIndexes(table, '없는컬럼', '영업');

    // Assert
    expect(matches).toEqual([]);
  });
});

describe('자료 사실: 컬럼의 서로 다른 값', () => {
  it('앞뒤 공백을 지운 뒤 중복과 빈 값을 빼고 처음 나온 순서로 돌려준다', () => {
    // Arrange
    const table: CsvTable = {
      headers: ['사번', '부서'],
      rows: [
        ['E1', ' 영업 '],
        ['E2', '개발'],
        ['E3', '영업'],
        ['E4', '   '],
        ['E5', ''],
      ],
    };

    // Act
    const values = distinctColumnValues(table, '부서');

    // Assert
    expect(values).toEqual(['영업', '개발']);
  });

  it('칸이 모자란 행은 건너뛴다', () => {
    // Arrange
    const table: CsvTable = { headers: ['사번', '부서'], rows: [['E1'], ['E2', '개발']] };

    // Act
    const values = distinctColumnValues(table, '부서');

    // Assert
    expect(values).toEqual(['개발']);
  });

  it('없는 컬럼이면 빈 목록이다', () => {
    // Arrange
    const table: CsvTable = { headers: ['사번'], rows: [['E1']] };

    // Act
    const values = distinctColumnValues(table, '부서');

    // Assert
    expect(values).toEqual([]);
  });
});
