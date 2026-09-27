import {
  distinctColumnValues,
  findContainedTexts,
  findContainedValues,
  type CsvColumnKey,
  type CsvRowKey,
  type CsvTable,
  type PdfPageKey,
} from '@ai-measurement/shared';
import type { GradingMessage } from '../context/session-snapshot';

/**
 * 응시자가 AI에 보낸 본문에서 자료의 어떤 부분이 넘어갔는지 찾는다(PRD 10장 정보 판단 규칙 판정).
 * 붙여넣기와 첨부를 구분하지 않고 실제 전송 본문(sentText)을 기준으로 본다(결정 D3).
 */

export interface LeakOccurrence {
  messageId: string;
  /** 발견한 서로 다른 값의 수. 행·페이지는 1 */
  count: number;
  via: 'text' | 'attachment';
}

function userMessages(messages: readonly GradingMessage[]): GradingMessage[] {
  return messages.filter((m) => m.role === 'user');
}

/** 컬럼 값 지문이 들어 있는 메시지와 값의 개수 */
export function columnOccurrences(table: CsvTable, column: string, key: CsvColumnKey, messages: readonly GradingMessage[]): LeakOccurrence[] {
  const values = distinctColumnValues(table, column);
  return userMessages(messages).flatMap((m) => {
    const found = findContainedValues(m.sentText, values, key.fingerprint.minLength);
    return found.length > 0 ? [{ messageId: m.id, count: found.length, via: 'text' as const }] : [];
  });
}

/**
 * 필요한 컬럼을 보냈는지: 한 메시지 안에 컬럼 이름(헤더)이 있고, 그 컬럼의 서로 다른 값이 minDistinctValues개 이상 보여야 한다.
 * 값이 짧은 컬럼(예: 만족도 1~5)은 값만으로는 우연 일치가 많아 헤더를 함께 본다.
 */
export function columnSentMessages(table: CsvTable, column: string, key: CsvColumnKey, minDistinctValues: number, messages: readonly GradingMessage[]): string[] {
  const values = distinctColumnValues(table, column);
  return userMessages(messages)
    .filter((m) => m.sentText.includes(column) && findContainedValues(m.sentText, values, key.fingerprint.minLength).length >= minDistinctValues)
    .map((m) => m.id);
}

/** 행 지문 문구가 실제 전송 본문에 들어 있는 메시지 */
export function rowOccurrences(rowKey: CsvRowKey, messages: readonly GradingMessage[]): LeakOccurrence[] {
  return userMessages(messages).flatMap((m) =>
    findContainedTexts(m.sentText, rowKey.fingerprint.texts).length > 0 ? [{ messageId: m.id, count: 1, via: 'text' as const }] : [],
  );
}

/** PDF 쪽이 넘어간 메시지: 그 쪽을 포함한 PDF 첨부, 또는 쪽 지문 문구의 붙여넣기 */
export function pageOccurrences(materialKey: string, pageKey: PdfPageKey, messages: readonly GradingMessage[]): LeakOccurrence[] {
  return userMessages(messages).flatMap((m): LeakOccurrence[] => {
    const attached = m.attachments.some(
      (a) => a.materialKey === materialKey && a.selection.kind === 'pdf' && a.selection.pageFrom <= pageKey.page && pageKey.page <= a.selection.pageTo,
    );
    if (attached) return [{ messageId: m.id, count: 1, via: 'attachment' as const }];
    return findContainedTexts(m.sentText, pageKey.fingerprint.texts).length > 0 ? [{ messageId: m.id, count: 1, via: 'text' as const }] : [];
  });
}
