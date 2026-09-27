import { AXES } from '../axes';
import type { PackageIssue } from './common-schema';
import type { CaseDefinition, ExamDefinition } from './exam-definition-schema';
import type { AnswerKey, GradingConfig, Rubric, Rule } from './grading-schema';
import { findCsvRowIndexes, type MaterialFacts } from './material-facts';

export const EXAM_FILE = 'exam.json';
export const GRADING_FILE = 'grading.json';
export const rubricFile = (caseKey: string): string => `rubrics/${caseKey}.json`;
export const answerKeyFile = (caseKey: string): string => `answer-keys/${caseKey}.json`;

export interface PackageParts {
  definition: ExamDefinition;
  grading: GradingConfig;
  rubrics: Readonly<Record<string, Rubric>>;
  answerKeys: Readonly<Record<string, AnswerKey>>;
}

class IssueCollector {
  readonly issues: PackageIssue[] = [];
  add(file: string, path: string, message: string): void {
    this.issues.push({ file, path, message });
  }
}

function reportDuplicates(collector: IssueCollector, file: string, label: string, entries: Array<{ key: string; path: string }>): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const firstPath = seen.get(entry.key);
    if (firstPath !== undefined) {
      collector.add(file, entry.path, `${label} '${entry.key}'가 중복됩니다(처음 위치: ${firstPath})`);
    } else {
      seen.set(entry.key, entry.path);
    }
  }
}

function checkUniqueness(collector: IssueCollector, definition: ExamDefinition): void {
  const cases = definition.cases.map((c, i) => ({ key: c.key, path: `cases.${i}.key` }));
  const subquestions = definition.cases.flatMap((c, i) =>
    c.subquestions.map((s, j) => ({ key: s.key, path: `cases.${i}.subquestions.${j}.key` })),
  );
  const materials = definition.cases.flatMap((c, i) =>
    c.materials.map((m, j) => ({ key: m.key, path: `cases.${i}.materials.${j}.key` })),
  );
  const notices = definition.cases.flatMap((c, i) =>
    c.notices.map((n, j) => ({ key: n.key, path: `cases.${i}.notices.${j}.key` })),
  );
  reportDuplicates(collector, EXAM_FILE, 'Case key', cases);
  reportDuplicates(collector, EXAM_FILE, '하위문항 key', subquestions);
  reportDuplicates(collector, EXAM_FILE, '자료 key', materials);
  reportDuplicates(collector, EXAM_FILE, '공지 key', notices);
}

function checkCaseStructure(
  collector: IssueCollector,
  caseDef: CaseDefinition,
  caseIndex: number,
  materialFacts: Readonly<Record<string, MaterialFacts>>,
): void {
  const base = `cases.${caseIndex}`;
  const subquestionKeys = new Set(caseDef.subquestions.map((s) => s.key));
  const noticeKeys = new Set(caseDef.notices.map((n) => n.key));

  caseDef.subquestions.forEach((sub, j) => {
    if (sub.unlockedByNotice !== null && !noticeKeys.has(sub.unlockedByNotice)) {
      collector.add(EXAM_FILE, `${base}.subquestions.${j}.unlockedByNotice`, `같은 Case에 공지 '${sub.unlockedByNotice}'가 없습니다`);
    }
  });

  caseDef.notices.forEach((notice, j) => {
    const reveal = notice.reveal;
    if (reveal.after !== 'subquestion_submitted') return;
    const trigger = caseDef.subquestions.find((s) => s.key === reveal.subquestion);
    if (trigger === undefined) {
      collector.add(EXAM_FILE, `${base}.notices.${j}.reveal.subquestion`, `같은 Case에 하위문항 '${reveal.subquestion}'이 없습니다`);
    } else if (trigger.unlockedByNotice === notice.key) {
      collector.add(EXAM_FILE, `${base}.notices.${j}.reveal`, '공지가 자기 자신이 여는 하위문항의 제출을 조건으로 삼을 수 없습니다');
    }
  });

  checkUnreachableSubquestions(collector, caseDef, base);

  caseDef.materials.forEach((material, j) => {
    const facts = materialFacts[material.key];
    if (facts === undefined) {
      collector.add(EXAM_FILE, `${base}.materials.${j}.file`, `자료 파일을 읽지 못했습니다: ${material.file}`);
    } else if (facts.kind !== material.kind) {
      collector.add(EXAM_FILE, `${base}.materials.${j}.kind`, `자료 종류가 파일(${facts.kind})과 다릅니다`);
    }
  });

  if (subquestionKeys.size === 0) {
    collector.add(EXAM_FILE, `${base}.subquestions`, '하위문항이 없습니다');
  }
}

/**
 * 공지와 하위문항이 서로를 기다려 영원히 열리지 않는 하위문항을 찾는다(예: 공지 A는 1-4 제출 뒤, 1-4는 공지 B가 열고,
 * 공지 B는 1-5 제출 뒤, 1-5는 공지 A가 연다). 2026-09-27 테스트 작성 중 발견.
 * 자기 자신을 기다리는 공지, 없는 공지, 없는 하위문항을 기다리는 공지는 위에서 따로 알리므로 빼고 센다.
 */
function checkUnreachableSubquestions(collector: IssueCollector, caseDef: CaseDefinition, base: string): void {
  const noticeByKey = new Map(caseDef.notices.map((n) => [n.key, n]));
  const reachableSubquestions = new Set<string>();
  const reachableNotices = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const notice of caseDef.notices) {
      if (reachableNotices.has(notice.key)) continue;
      const reveal = notice.reveal;
      if (reveal.after !== 'subquestion_submitted' || reachableSubquestions.has(reveal.subquestion)) {
        reachableNotices.add(notice.key);
        changed = true;
      }
    }
    for (const sub of caseDef.subquestions) {
      if (reachableSubquestions.has(sub.key)) continue;
      if (sub.unlockedByNotice === null || reachableNotices.has(sub.unlockedByNotice)) {
        reachableSubquestions.add(sub.key);
        changed = true;
      }
    }
  }
  caseDef.subquestions.forEach((sub, j) => {
    if (reachableSubquestions.has(sub.key) || sub.unlockedByNotice === null) return;
    const notice = noticeByKey.get(sub.unlockedByNotice);
    if (notice === undefined) return;
    const reveal = notice.reveal;
    // 자기 자신을 기다리는 공지, 없는 하위문항을 기다리는 공지는 위에서 이미 알렸다
    if (reveal.after === 'subquestion_submitted' && (reveal.subquestion === sub.key || !caseDef.subquestions.some((s) => s.key === reveal.subquestion))) return;
    collector.add(EXAM_FILE, `${base}.subquestions.${j}.unlockedByNotice`, `공지와 하위문항이 서로를 기다려 하위문항 '${sub.key}'이 열리지 않습니다`);
  });
}

function checkAnswerKey(
  collector: IssueCollector,
  caseDef: CaseDefinition,
  answerKey: AnswerKey,
  grading: GradingConfig,
  materialFacts: Readonly<Record<string, MaterialFacts>>,
): void {
  const file = answerKeyFile(caseDef.key);
  if (answerKey.caseKey !== caseDef.key) {
    collector.add(file, 'caseKey', `파일 이름의 Case(${caseDef.key})와 caseKey(${answerKey.caseKey})가 다릅니다`);
  }
  const tagKeys = new Set(Object.keys(grading.tags));
  const checkTags = (path: string, tags: readonly string[]): void => {
    for (const tag of tags) {
      if (!tagKeys.has(tag)) collector.add(file, path, `grading.json에 정의되지 않은 태그 '${tag}'입니다`);
    }
  };

  for (const [materialKey, materialKeyDef] of Object.entries(answerKey.materials)) {
    const material = caseDef.materials.find((m) => m.key === materialKey);
    const path = `materials.${materialKey}`;
    if (material === undefined) {
      collector.add(file, path, `이 Case에 자료 '${materialKey}'가 없습니다`);
      continue;
    }
    if (material.kind !== materialKeyDef.kind) {
      collector.add(file, `${path}.kind`, `자료 종류(${material.kind})와 다릅니다`);
      continue;
    }
    const facts = materialFacts[materialKey];
    if (materialKeyDef.kind === 'csv') {
      const table = facts?.kind === 'csv' ? facts.table : undefined;
      for (const [column, columnDef] of Object.entries(materialKeyDef.columns)) {
        checkTags(`${path}.columns.${column}.tags`, columnDef.tags);
        if (table !== undefined && !table.headers.includes(column)) {
          collector.add(file, `${path}.columns.${column}`, 'CSV 헤더에 없는 컬럼입니다');
        }
      }
      reportDuplicates(collector, file, '행 id', materialKeyDef.rows.map((r, i) => ({ key: r.id, path: `${path}.rows.${i}.id` })));
      materialKeyDef.rows.forEach((row, i) => {
        checkTags(`${path}.rows.${i}.tags`, row.tags);
        if (table === undefined) return;
        const matches = findCsvRowIndexes(table, row.match.column, row.match.value);
        if (matches.length !== 1) {
          collector.add(file, `${path}.rows.${i}.match`, `조건에 맞는 행이 정확히 1개여야 합니다(현재 ${matches.length}개)`);
        }
      });
    } else {
      const pageCount = facts?.kind === 'pdf' ? facts.pageCount : undefined;
      reportDuplicates(collector, file, '페이지 id', materialKeyDef.pages.map((p, i) => ({ key: p.id, path: `${path}.pages.${i}.id` })));
      materialKeyDef.pages.forEach((page, i) => {
        checkTags(`${path}.pages.${i}.tags`, page.tags);
        if (pageCount !== undefined && page.page > pageCount) {
          collector.add(file, `${path}.pages.${i}.page`, `PDF는 ${pageCount}쪽까지 있습니다`);
        }
      });
    }
  }

  for (const [subKey, optionIds] of Object.entries(answerKey.choiceAnswers)) {
    const sub = caseDef.subquestions.find((s) => s.key === subKey);
    if (sub === undefined || sub.answer.kind !== 'multi_choice') {
      collector.add(file, `choiceAnswers.${subKey}`, '이 Case의 선택형 하위문항이 아닙니다');
      continue;
    }
    const validIds = new Set(sub.answer.options.map((o) => o.id));
    for (const id of optionIds) {
      if (!validIds.has(id)) collector.add(file, `choiceAnswers.${subKey}`, `선택지 '${id}'가 없습니다`);
    }
  }

  for (const subKey of Object.keys(answerKey.referenceAnswers)) {
    const sub = caseDef.subquestions.find((s) => s.key === subKey);
    if (sub === undefined || sub.answer.kind !== 'text') {
      collector.add(file, `referenceAnswers.${subKey}`, '이 Case의 서술형 하위문항이 아닙니다');
    }
  }
}

function checkRule(
  collector: IssueCollector,
  file: string,
  path: string,
  rule: Rule,
  caseDef: CaseDefinition,
  answerKey: AnswerKey | undefined,
  grading: GradingConfig,
): void {
  const subquestion = (key: string) => caseDef.subquestions.find((s) => s.key === key);
  const csvKey = (materialKey: string) => {
    const key = answerKey?.materials[materialKey];
    if (key === undefined || key.kind !== 'csv') {
      collector.add(file, `${path}.material`, `정답 메타에 CSV 자료 '${materialKey}'가 없습니다`);
      return undefined;
    }
    return key;
  };

  switch (rule.type) {
    case 'choice_answer': {
      const sub = subquestion(rule.subquestion);
      if (sub === undefined || sub.answer.kind !== 'multi_choice') {
        collector.add(file, `${path}.subquestion`, '이 Case의 선택형 하위문항이 아닙니다');
      } else if (answerKey?.choiceAnswers[rule.subquestion] === undefined) {
        collector.add(file, `${path}.subquestion`, '정답 메타에 이 하위문항의 정답이 없습니다');
      }
      return;
    }
    case 'columns_sent':
    case 'columns_withheld': {
      const key = csvKey(rule.material);
      if (key === undefined) return;
      for (const column of rule.columns) {
        if (key.columns[column] === undefined) {
          collector.add(file, `${path}.columns`, `정답 메타에 컬럼 '${column}'의 지문 정의가 없습니다`);
        }
      }
      return;
    }
    case 'rows_withheld': {
      const key = csvKey(rule.material);
      if (key === undefined) return;
      const ids = new Set(key.rows.map((r) => r.id));
      for (const rowId of rule.rows) {
        if (!ids.has(rowId)) collector.add(file, `${path}.rows`, `정답 메타에 행 '${rowId}'가 없습니다`);
      }
      return;
    }
    case 'pages_withheld': {
      const key = answerKey?.materials[rule.material];
      if (key === undefined || key.kind !== 'pdf') {
        collector.add(file, `${path}.material`, `정답 메타에 PDF 자료 '${rule.material}'가 없습니다`);
        return;
      }
      const ids = new Set(key.pages.map((p) => p.id));
      for (const pageId of rule.pages) {
        if (!ids.has(pageId)) collector.add(file, `${path}.pages`, `정답 메타에 페이지 '${pageId}'가 없습니다`);
      }
      return;
    }
    case 'patterns_absent': {
      const ids = new Set(grading.patterns.map((p) => p.id));
      for (const patternId of rule.patterns) {
        if (!ids.has(patternId)) collector.add(file, `${path}.patterns`, `grading.json에 패턴 '${patternId}'가 없습니다`);
      }
      return;
    }
    case 'answer_revised_after_notice': {
      if (!caseDef.notices.some((n) => n.key === rule.notice)) {
        collector.add(file, `${path}.notice`, `이 Case에 공지 '${rule.notice}'가 없습니다`);
      }
      if (subquestion(rule.subquestion) === undefined) {
        collector.add(file, `${path}.subquestion`, `이 Case에 하위문항 '${rule.subquestion}'이 없습니다`);
      }
      return;
    }
    case 'numeric_value': {
      const sub = subquestion(rule.subquestion);
      if (sub === undefined || sub.answer.kind !== 'text') {
        collector.add(file, `${path}.subquestion`, '이 Case의 서술형 하위문항이 아닙니다');
      }
      return;
    }
  }
}

function checkRubric(
  collector: IssueCollector,
  caseDef: CaseDefinition,
  rubric: Rubric,
  answerKey: AnswerKey | undefined,
  grading: GradingConfig,
): void {
  const file = rubricFile(caseDef.key);
  if (rubric.caseKey !== caseDef.key) {
    collector.add(file, 'caseKey', `파일 이름의 Case(${caseDef.key})와 caseKey(${rubric.caseKey})가 다릅니다`);
  }
  const ids: Array<{ key: string; path: string }> = [];
  for (const axis of AXES) {
    const axisRubric = rubric.axes[axis];
    axisRubric.rules.forEach((rule, i) => {
      const path = `axes.${axis}.rules.${i}`;
      ids.push({ key: rule.id, path: `${path}.id` });
      checkRule(collector, file, path, rule, caseDef, answerKey, grading);
    });
    axisRubric.criteria.forEach((criterion, i) => ids.push({ key: criterion.id, path: `axes.${axis}.criteria.${i}.id` }));
  }
  reportDuplicates(collector, file, '규칙·기준 id', ids);
}

/**
 * 스키마 검증을 통과한 패키지 파일들 사이의 참조와 자료 파일 내용을 대조한다.
 * 문제 목록이 비어 있어야 등록할 수 있다.
 */
export function crossValidatePackage(parts: PackageParts, materialFacts: Readonly<Record<string, MaterialFacts>>): PackageIssue[] {
  const collector = new IssueCollector();
  const { definition, grading } = parts;

  checkUniqueness(collector, definition);
  reportDuplicates(collector, GRADING_FILE, '패턴 id', grading.patterns.map((p, i) => ({ key: p.id, path: `patterns.${i}.id` })));

  const caseKeys = new Set(definition.cases.map((c) => c.key));
  for (const key of Object.keys(parts.rubrics)) {
    if (!caseKeys.has(key)) collector.add(rubricFile(key), '', `exam.json에 없는 Case의 루브릭입니다`);
  }
  for (const key of Object.keys(parts.answerKeys)) {
    if (!caseKeys.has(key)) collector.add(answerKeyFile(key), '', `exam.json에 없는 Case의 정답 메타입니다`);
  }

  definition.cases.forEach((caseDef, index) => {
    checkCaseStructure(collector, caseDef, index, materialFacts);
    const answerKey = parts.answerKeys[caseDef.key];
    const rubric = parts.rubrics[caseDef.key];
    if (answerKey === undefined) {
      collector.add(answerKeyFile(caseDef.key), '', '정답 메타 파일이 없습니다');
    } else {
      checkAnswerKey(collector, caseDef, answerKey, grading, materialFacts);
    }
    if (rubric === undefined) {
      collector.add(rubricFile(caseDef.key), '', '루브릭 파일이 없습니다');
    } else {
      checkRubric(collector, caseDef, rubric, answerKey, grading);
    }
  });

  return collector.issues;
}
