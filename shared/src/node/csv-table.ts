import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import type { CsvTable } from '../exam-package/material-facts';

export class CsvFormatError extends Error {
  override readonly name = 'CsvFormatError';
}

export class CsvSelectionError extends Error {
  override readonly name = 'CsvSelectionError';
}

export function parseCsvText(text: string): CsvTable {
  let records: string[][];
  try {
    records = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: false }) as string[][];
  } catch (error) {
    throw new CsvFormatError(`CSV를 해석할 수 없습니다: ${(error as Error).message}`);
  }
  const [headers, ...rows] = records;
  if (headers === undefined) throw new CsvFormatError('CSV에 헤더 행이 없습니다');
  const trimmed = headers.map((h) => h.trim());
  if (trimmed.some((h) => h.length === 0)) throw new CsvFormatError('빈 헤더가 있습니다');
  if (new Set(trimmed).size !== trimmed.length) throw new CsvFormatError('헤더 이름이 중복됩니다');
  return { headers: trimmed, rows };
}

export interface CsvSelection {
  /** 보낼 컬럼 이름. 원래 CSV의 컬럼 순서로 정렬해서 보낸다 */
  columns: readonly string[];
  /** 보낼 행의 0부터 시작하는 인덱스. 원래 순서로 정렬해서 보낸다 */
  rowIndexes: readonly number[];
}

export function selectCsv(table: CsvTable, selection: CsvSelection): CsvTable {
  if (selection.columns.length === 0) throw new CsvSelectionError('컬럼을 하나 이상 골라야 합니다');
  if (selection.rowIndexes.length === 0) throw new CsvSelectionError('행을 하나 이상 골라야 합니다');
  const requested = new Set(selection.columns);
  if (requested.size !== selection.columns.length) throw new CsvSelectionError('같은 컬럼을 두 번 고를 수 없습니다');
  for (const column of requested) {
    if (!table.headers.includes(column)) throw new CsvSelectionError(`없는 컬럼입니다: ${column}`);
  }
  const rowSet = new Set(selection.rowIndexes);
  if (rowSet.size !== selection.rowIndexes.length) throw new CsvSelectionError('같은 행을 두 번 고를 수 없습니다');
  for (const index of rowSet) {
    if (!Number.isInteger(index) || index < 0 || index >= table.rows.length) {
      throw new CsvSelectionError(`없는 행 번호입니다: ${index}`);
    }
  }
  const columnIndexes = table.headers.map((h, i) => (requested.has(h) ? i : -1)).filter((i) => i >= 0);
  const rows = [...rowSet]
    .sort((a, b) => a - b)
    .map((rowIndex) =>
      columnIndexes.map((ci) => {
        // 파서는 칸 수가 다른 행을 만들지 않는다. 비어 있으면 표가 잘못 만들어진 것이므로 빈 값으로 메우지 않는다
        const cell = table.rows[rowIndex]?.[ci];
        if (cell === undefined) throw new CsvSelectionError(`${rowIndex}번 행에 '${table.headers[ci]}' 칸이 없습니다`);
        return cell;
      }),
    );
  return { headers: columnIndexes.map((ci) => table.headers[ci] as string), rows };
}

export function renderCsv(table: CsvTable): string {
  return stringify([table.headers, ...table.rows]);
}
