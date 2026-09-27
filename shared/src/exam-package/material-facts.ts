/** 자료 파일을 읽어 얻은 사실. 교차 검증과 채점이 쓴다. */

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

export type MaterialFacts =
  | { kind: 'csv'; table: CsvTable }
  | { kind: 'pdf'; pageCount: number };

/** 조건에 맞는 행의 0부터 시작하는 인덱스 목록 */
export function findCsvRowIndexes(table: CsvTable, column: string, value: string): number[] {
  const columnIndex = table.headers.indexOf(column);
  if (columnIndex < 0) return [];
  const matches: number[] = [];
  table.rows.forEach((row, index) => {
    if (row[columnIndex] === value) matches.push(index);
  });
  return matches;
}

/** 한 컬럼의 서로 다른 값 목록(빈 값 제외) */
export function distinctColumnValues(table: CsvTable, column: string): string[] {
  const columnIndex = table.headers.indexOf(column);
  if (columnIndex < 0) return [];
  const values = new Set<string>();
  for (const row of table.rows) {
    const cell = row[columnIndex];
    if (cell !== undefined && cell.trim().length > 0) values.add(cell.trim());
  }
  return [...values];
}
