import { findPatternHits, type MaterialFacts } from '@ai-measurement/shared';
import type { SessionSnapshot } from '../context/session-snapshot';
import type { GradingExam } from '../rules/item-result';
import { columnOccurrences, pageOccurrences, rowOccurrences, type LeakOccurrence } from '../rules/leak-detection';

export interface ViolationRecord {
  messageId: string;
  source: 'column' | 'row' | 'page' | 'pattern';
  tag: string;
  label: string;
  count: number;
  detail: Record<string, unknown>;
}

function severeTag(exam: GradingExam, tags: readonly string[]): string | null {
  return tags.find((t) => exam.grading.tags[t]?.severe === true) ?? null;
}

function records(occurrences: readonly LeakOccurrence[], source: ViolationRecord['source'], tag: string, label: string, detail: Record<string, unknown>): ViolationRecord[] {
  return occurrences.map((o) => ({ messageId: o.messageId, source, tag, label, count: o.count, detail: { ...detail, via: o.via } }));
}

/**
 * 중대 보안 위반(PRD 9장): 중대(severe) 태그가 붙은 컬럼·행·쪽이 AI에 넘어갔거나, 중대 패턴이 본문에 있으면 기록한다.
 * 점수와 별개로 남기며, 처리 기준은 시험의 violationPolicy가 정한다(결정 D13).
 */
export function findSevereViolations(exam: GradingExam, materials: Readonly<Record<string, MaterialFacts>>, snapshot: SessionSnapshot): ViolationRecord[] {
  const found: ViolationRecord[] = [];
  for (const answerKey of Object.values(exam.answerKeys)) {
    for (const [materialKey, materialKeyDef] of Object.entries(answerKey.materials)) {
      if (materialKeyDef.kind === 'csv') {
        const facts = materials[materialKey];
        if (facts?.kind !== 'csv') throw new Error(`CSV 자료를 읽지 못했습니다: ${materialKey}`);
        for (const [column, columnKey] of Object.entries(materialKeyDef.columns)) {
          const tag = severeTag(exam, columnKey.tags);
          if (tag !== null) found.push(...records(columnOccurrences(facts.table, column, columnKey, snapshot.messages), 'column', tag, columnKey.label, { materialKey, column }));
        }
        for (const rowKey of materialKeyDef.rows) {
          const tag = severeTag(exam, rowKey.tags);
          if (tag !== null) found.push(...records(rowOccurrences(rowKey, snapshot.messages), 'row', tag, rowKey.label, { materialKey, rowId: rowKey.id }));
        }
      } else {
        for (const pageKey of materialKeyDef.pages) {
          const tag = severeTag(exam, pageKey.tags);
          if (tag !== null) found.push(...records(pageOccurrences(materialKey, pageKey, snapshot.messages), 'page', tag, pageKey.label, { materialKey, pageId: pageKey.id }));
        }
      }
    }
  }
  const severePatterns = exam.grading.patterns.filter((p) => p.severe);
  for (const message of snapshot.messages.filter((m) => m.role === 'user')) {
    for (const hit of findPatternHits(message.sentText, severePatterns)) {
      const pattern = severePatterns.find((p) => p.id === hit.patternId);
      if (pattern !== undefined) found.push({ messageId: message.id, source: 'pattern', tag: pattern.id, label: pattern.label, count: hit.count, detail: {} });
    }
  }
  return found;
}
