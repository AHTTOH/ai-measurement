import type { AnswerKey, CaseDefinition, Rubric } from '@ai-measurement/shared';

export interface GeneratedFile {
  /** 패키지 루트 기준 상대 경로 */
  relativePath: string;
  content: Uint8Array | string;
}

export interface CaseBundle {
  caseDef: CaseDefinition;
  rubric: Rubric;
  answerKey: AnswerKey;
  files: GeneratedFile[];
}

/** 엑셀에서 한글이 깨지지 않도록 CSV 앞에 붙이는 UTF-8 BOM */
export const CSV_BOM = '﻿';

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function markdownTable(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const line = (cells: ReadonlyArray<string | number>) => `| ${cells.map(String).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

export function formatWon(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

export function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = a;
  }
  return copy;
}
