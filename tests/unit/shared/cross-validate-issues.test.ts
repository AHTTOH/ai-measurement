import { beforeAll, describe, expect, it } from 'vitest';
import {
  crossValidatePackage,
  type AnswerKey,
  type Axis,
  type CaseDefinition,
  type MaterialAnswerKey,
  type MaterialFacts,
  type PackageIssue,
  type PackageParts,
  type Rubric,
  type Rule,
} from '@ai-measurement/shared';
import type { LoadedExamPackage } from '@ai-measurement/shared/node';
import { loadSamplePackage } from './sample-package';

/** 샘플 패키지를 한 번만 읽고, 테스트마다 깊은 복사본을 고쳐 교차 검증 분기를 하나씩 건드린다. */

interface Fixture {
  parts: PackageParts;
  facts: Record<string, MaterialFacts>;
}

type CsvMaterialKey = Extract<MaterialAnswerKey, { kind: 'csv' }>;
type PdfMaterialKey = Extract<MaterialAnswerKey, { kind: 'pdf' }>;

let sample: LoadedExamPackage;

beforeAll(async () => {
  sample = await loadSamplePackage();
}, 120_000);

function fixture(): Fixture {
  return structuredClone({
    parts: {
      definition: sample.definition,
      grading: sample.grading,
      rubrics: sample.rubrics,
      answerKeys: sample.answerKeys,
    },
    facts: sample.materialFacts,
  });
}

function validate(f: Fixture): PackageIssue[] {
  return crossValidatePackage(f.parts, f.facts);
}

function issue(file: string, path: string, message: string): PackageIssue {
  return { file, path, message };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`샘플 구조가 예상과 다릅니다: ${what}`);
  return value;
}

function caseOf(f: Fixture, key: string): CaseDefinition {
  return must(f.parts.definition.cases.find((c) => c.key === key), `case ${key}`);
}

function answerKeyOf(f: Fixture, caseKey: string): AnswerKey {
  return must(f.parts.answerKeys[caseKey], `answer key ${caseKey}`);
}

function rubricOf(f: Fixture, caseKey: string): Rubric {
  return must(f.parts.rubrics[caseKey], `rubric ${caseKey}`);
}

function csvKeyOf(answerKey: AnswerKey, materialKey: string): CsvMaterialKey {
  const key = answerKey.materials[materialKey];
  if (key?.kind !== 'csv') throw new Error(`샘플 구조가 예상과 다릅니다: csv ${materialKey}`);
  return key;
}

function pdfKeyOf(answerKey: AnswerKey, materialKey: string): PdfMaterialKey {
  const key = answerKey.materials[materialKey];
  if (key?.kind !== 'pdf') throw new Error(`샘플 구조가 예상과 다릅니다: pdf ${materialKey}`);
  return key;
}

function ruleOf<T extends Rule['type']>(rubric: Rubric, axis: Axis, index: number, type: T): Extract<Rule, { type: T }> {
  const rule = rubric.axes[axis].rules[index];
  if (rule?.type !== type) throw new Error(`샘플 구조가 예상과 다릅니다: ${axis}.rules.${index}는 ${type}이어야 합니다`);
  return rule as Extract<Rule, { type: T }>;
}

function withoutKey<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

describe('교차 검증: 기준 상태', () => {
  it('고치지 않은 샘플 패키지는 문제가 없다', () => {
    // Arrange
    const f = fixture();

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([]);
  });
});

describe('교차 검증: 식별자 중복', () => {
  it('Case key 중복을 처음 위치와 함께 알려준다', () => {
    // Arrange
    const f = fixture();
    const copy = structuredClone(caseOf(f, 'customer-voc'));
    f.parts.definition.cases.push(copy);

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toContainEqual(issue('exam.json', 'cases.3.key', "Case key 'customer-voc'가 중복됩니다(처음 위치: cases.1.key)"));
  });

  it('자료 key 중복을 찾는다', () => {
    // Arrange
    const f = fixture();
    const travel = caseOf(f, 'travel-expense');
    const expenses = must(travel.materials[1], 'expenses material');
    expenses.key = 'travel-policy';

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toContainEqual(
      issue('exam.json', 'cases.2.materials.1.key', "자료 key 'travel-policy'가 중복됩니다(처음 위치: cases.2.materials.0.key)"),
    );
  });

  it('공지 key 중복만 있으면 그 문제 하나만 돌려준다', () => {
    // Arrange
    const f = fixture();
    const hr = caseOf(f, 'hr-survey');
    hr.notices.push(structuredClone(must(hr.notices[0], 'hr notice')));

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('exam.json', 'cases.0.notices.1.key', "공지 key 'privacy-small-org'가 중복됩니다(처음 위치: cases.0.notices.0.key)"),
    ]);
  });

  it('grading.json 패턴 id 중복을 찾는다', () => {
    // Arrange
    const f = fixture();
    f.parts.grading.patterns.push(structuredClone(must(f.parts.grading.patterns[0], 'pattern 0')));

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('grading.json', 'patterns.3.id', "패턴 id 'rrn'가 중복됩니다(처음 위치: patterns.0.id)")]);
  });

  it('루브릭 안 규칙·기준 id 중복을 축을 넘어 찾는다', () => {
    // Arrange
    const f = fixture();
    const criterion = must(rubricOf(f, 'hr-survey').axes.usage.criteria[0], 'usage criterion 0');
    criterion.id = 'j-choice';

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('rubrics/hr-survey.json', 'axes.usage.criteria.0.id', "규칙·기준 id 'j-choice'가 중복됩니다(처음 위치: axes.judgment.rules.0.id)"),
    ]);
  });
});

describe('교차 검증: 파일 대응', () => {
  it('exam.json에 없는 Case의 루브릭을 찾는다', () => {
    // Arrange
    const f = fixture();
    const ghost = { ...structuredClone(rubricOf(f, 'hr-survey')), caseKey: 'ghost' };
    f.parts = { ...f.parts, rubrics: { ...f.parts.rubrics, ghost } };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/ghost.json', '', 'exam.json에 없는 Case의 루브릭입니다')]);
  });

  it('exam.json에 없는 Case의 정답 메타를 찾는다', () => {
    // Arrange
    const f = fixture();
    const ghost = { ...structuredClone(answerKeyOf(f, 'hr-survey')), caseKey: 'ghost' };
    f.parts = { ...f.parts, answerKeys: { ...f.parts.answerKeys, ghost } };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('answer-keys/ghost.json', '', 'exam.json에 없는 Case의 정답 메타입니다')]);
  });

  it('정답 메타가 없으면 그 사실과 정답 메타를 참조하는 규칙을 모두 알려준다', () => {
    // Arrange
    const f = fixture();
    f.parts = { ...f.parts, answerKeys: withoutKey(f.parts.answerKeys, 'customer-voc') };

    // Act
    const issues = validate(f);

    // Assert
    const rubric = 'rubrics/customer-voc.json';
    expect(issues).toEqual([
      issue('answer-keys/customer-voc.json', '', '정답 메타 파일이 없습니다'),
      issue(rubric, 'axes.judgment.rules.0.subquestion', '정답 메타에 이 하위문항의 정답이 없습니다'),
      issue(rubric, 'axes.judgment.rules.1.material', "정답 메타에 CSV 자료 'voc'가 없습니다"),
      issue(rubric, 'axes.judgment.rules.2.material', "정답 메타에 CSV 자료 'voc'가 없습니다"),
      issue(rubric, 'axes.judgment.rules.3.material', "정답 메타에 CSV 자료 'voc'가 없습니다"),
      issue(rubric, 'axes.judgment.rules.4.material', "정답 메타에 CSV 자료 'voc'가 없습니다"),
    ]);
  });

  it('PDF 규칙이 있는 Case의 정답 메타가 없으면 PDF 자료도 없다고 알려준다', () => {
    // Arrange
    const f = fixture();
    f.parts = { ...f.parts, answerKeys: withoutKey(f.parts.answerKeys, 'travel-expense') };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toContainEqual(issue('answer-keys/travel-expense.json', '', '정답 메타 파일이 없습니다'));
    expect(issues).toContainEqual(
      issue('rubrics/travel-expense.json', 'axes.judgment.rules.1.material', "정답 메타에 PDF 자료 'travel-policy'가 없습니다"),
    );
  });

  it('루브릭이 없으면 그 문제 하나만 돌려준다', () => {
    // Arrange
    const f = fixture();
    f.parts = { ...f.parts, rubrics: withoutKey(f.parts.rubrics, 'customer-voc') };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/customer-voc.json', '', '루브릭 파일이 없습니다')]);
  });
});

describe('교차 검증: Case 구조', () => {
  it('같은 Case에 없는 공지로 열리는 하위문항을 찾는다', () => {
    // Arrange
    const f = fixture();
    const sub = must(caseOf(f, 'travel-expense').subquestions[4], 'subquestion 3-5');
    sub.unlockedByNotice = 'no-such-notice';

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('exam.json', 'cases.2.subquestions.4.unlockedByNotice', "같은 Case에 공지 'no-such-notice'가 없습니다"),
    ]);
  });

  it('공지 조건이 없는 하위문항 제출을 가리키면 찾는다', () => {
    // Arrange
    const f = fixture();
    const notice = must(caseOf(f, 'hr-survey').notices[0], 'hr notice');
    notice.reveal = { after: 'subquestion_submitted', subquestion: '9-9' };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('exam.json', 'cases.0.notices.0.reveal.subquestion', "같은 Case에 하위문항 '9-9'이 없습니다")]);
  });

  it('CSV 자료 파일 사실이 없으면 파일을 읽지 못했다고 하고 헤더·행 대조는 건너뛴다', () => {
    // Arrange
    const f = fixture();
    f.facts = withoutKey(f.facts, 'voc');

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('exam.json', 'cases.1.materials.0.file', '자료 파일을 읽지 못했습니다: materials/voc.csv')]);
  });

  it('CSV로 선언한 자료가 실제로 PDF면 종류 불일치를 알려준다', () => {
    // Arrange
    const f = fixture();
    f.facts = { ...f.facts, voc: { kind: 'pdf', pageCount: 1 } };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('exam.json', 'cases.1.materials.0.kind', '자료 종류가 파일(pdf)과 다릅니다')]);
  });

  it('PDF 자료 파일 사실이 없으면 쪽수 대조를 건너뛴다', () => {
    // Arrange
    const f = fixture();
    f.facts = withoutKey(f.facts, 'travel-policy');
    pdfKeyOf(answerKeyOf(f, 'travel-expense'), 'travel-policy').pages.forEach((page) => {
      page.page = 999;
    });

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('exam.json', 'cases.2.materials.0.file', '자료 파일을 읽지 못했습니다: materials/travel-policy.pdf')]);
  });

  it('PDF로 선언한 자료가 실제로 CSV면 종류 불일치를 알려준다', () => {
    // Arrange
    const f = fixture();
    f.facts = { ...f.facts, 'travel-policy': { kind: 'csv', table: { headers: ['a'], rows: [] } } };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('exam.json', 'cases.2.materials.0.kind', '자료 종류가 파일(csv)과 다릅니다')]);
  });

  it('하위문항이 하나도 없는 Case를 찾는다', () => {
    // Arrange
    const f = fixture();
    caseOf(f, 'customer-voc').subquestions = [];

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toContainEqual(issue('exam.json', 'cases.1.subquestions', '하위문항이 없습니다'));
    expect(issues).toContainEqual(issue('answer-keys/customer-voc.json', 'choiceAnswers.2-1', '이 Case의 선택형 하위문항이 아닙니다'));
    expect(issues).toContainEqual(issue('answer-keys/customer-voc.json', 'referenceAnswers.2-3', '이 Case의 서술형 하위문항이 아닙니다'));
    expect(issues).toContainEqual(issue('rubrics/customer-voc.json', 'axes.output.rules.0.subquestion', '이 Case의 서술형 하위문항이 아닙니다'));
  });
});

describe('교차 검증: 정답 메타', () => {
  it('파일 이름의 Case와 caseKey가 다르면 찾는다', () => {
    // Arrange
    const f = fixture();
    answerKeyOf(f, 'customer-voc').caseKey = 'other-case';

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('answer-keys/customer-voc.json', 'caseKey', '파일 이름의 Case(customer-voc)와 caseKey(other-case)가 다릅니다'),
    ]);
  });

  it('Case에 없는 자료의 정답 메타를 찾고 그 자료의 세부 대조는 건너뛴다', () => {
    // Arrange
    const f = fixture();
    const employees = structuredClone(csvKeyOf(answerKeyOf(f, 'hr-survey'), 'employees'));
    answerKeyOf(f, 'customer-voc').materials['employees'] = employees;

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('answer-keys/customer-voc.json', 'materials.employees', "이 Case에 자료 'employees'가 없습니다")]);
  });

  it('자료 종류가 정의와 다르면 찾고, 그 자료를 CSV로 쓰는 규칙도 알려준다', () => {
    // Arrange
    const f = fixture();
    answerKeyOf(f, 'travel-expense').materials['expenses'] = { kind: 'pdf', pages: [] };

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('answer-keys/travel-expense.json', 'materials.expenses.kind', '자료 종류(csv)와 다릅니다'),
      issue('rubrics/travel-expense.json', 'axes.judgment.rules.2.material', "정답 메타에 CSV 자료 'expenses'가 없습니다"),
      issue('rubrics/travel-expense.json', 'axes.judgment.rules.3.material', "정답 메타에 CSV 자료 'expenses'가 없습니다"),
    ]);
  });

  it('CSV 행 id 중복을 찾는다', () => {
    // Arrange
    const f = fixture();
    const employees = csvKeyOf(answerKeyOf(f, 'hr-survey'), 'employees');
    employees.rows.push(structuredClone(must(employees.rows[0], 'row 0')));

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('answer-keys/hr-survey.json', 'materials.employees.rows.1.id', "행 id 'row-injection'가 중복됩니다(처음 위치: materials.employees.rows.0.id)"),
    ]);
  });

  it('PDF 페이지 id 중복을 찾는다', () => {
    // Arrange
    const f = fixture();
    const policy = pdfKeyOf(answerKeyOf(f, 'travel-expense'), 'travel-policy');
    policy.pages.push(structuredClone(must(policy.pages[0], 'page 0')));

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('answer-keys/travel-expense.json', 'materials.travel-policy.pages.1.id', "페이지 id 'page-3'가 중복됩니다(처음 위치: materials.travel-policy.pages.0.id)"),
    ]);
  });

  it('행과 페이지에 정의되지 않은 태그를 쓰면 찾는다', () => {
    // Arrange
    const f = fixture();
    must(csvKeyOf(answerKeyOf(f, 'hr-survey'), 'employees').rows[0], 'row 0').tags = ['row-tag'];
    must(pdfKeyOf(answerKeyOf(f, 'travel-expense'), 'travel-policy').pages[0], 'page 0').tags = ['page-tag'];

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('answer-keys/hr-survey.json', 'materials.employees.rows.0.tags', "grading.json에 정의되지 않은 태그 'row-tag'입니다"),
      issue('answer-keys/travel-expense.json', 'materials.travel-policy.pages.0.tags', "grading.json에 정의되지 않은 태그 'page-tag'입니다"),
    ]);
  });

  it('선택형 정답이 없는 하위문항·서술형 하위문항·없는 선택지를 가리키면 찾는다', () => {
    // Arrange
    const f = fixture();
    const answerKey = answerKeyOf(f, 'hr-survey');
    answerKey.choiceAnswers['9-9'] = ['name'];
    answerKey.choiceAnswers['1-2'] = ['name'];
    answerKey.choiceAnswers['1-1'] = ['name', 'bogus'];

    // Act
    const issues = validate(f);

    // Assert
    const file = 'answer-keys/hr-survey.json';
    expect(issues).toHaveLength(3);
    expect(issues).toContainEqual(issue(file, 'choiceAnswers.1-1', "선택지 'bogus'가 없습니다"));
    expect(issues).toContainEqual(issue(file, 'choiceAnswers.9-9', '이 Case의 선택형 하위문항이 아닙니다'));
    expect(issues).toContainEqual(issue(file, 'choiceAnswers.1-2', '이 Case의 선택형 하위문항이 아닙니다'));
  });

  it('기준답안이 없는 하위문항이나 선택형 하위문항을 가리키면 찾는다', () => {
    // Arrange
    const f = fixture();
    const answerKey = answerKeyOf(f, 'hr-survey');
    answerKey.referenceAnswers['9-9'] = '없는 문항의 기준답안';
    answerKey.referenceAnswers['1-1'] = '선택형 문항의 기준답안';

    // Act
    const issues = validate(f);

    // Assert
    const file = 'answer-keys/hr-survey.json';
    expect(issues).toHaveLength(2);
    expect(issues).toContainEqual(issue(file, 'referenceAnswers.9-9', '이 Case의 서술형 하위문항이 아닙니다'));
    expect(issues).toContainEqual(issue(file, 'referenceAnswers.1-1', '이 Case의 서술형 하위문항이 아닙니다'));
  });
});

describe('교차 검증: 루브릭 규칙', () => {
  it('루브릭 caseKey가 파일 이름의 Case와 다르면 찾는다', () => {
    // Arrange
    const f = fixture();
    rubricOf(f, 'hr-survey').caseKey = 'other-case';

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'caseKey', '파일 이름의 Case(hr-survey)와 caseKey(other-case)가 다릅니다')]);
  });

  it.each([
    ['서술형 하위문항', '1-2'],
    ['없는 하위문항', '9-9'],
  ])('choice_answer 규칙이 %s을 가리키면 찾는다', (_label, subquestion) => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'hr-survey'), 'judgment', 0, 'choice_answer').subquestion = subquestion;

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.judgment.rules.0.subquestion', '이 Case의 선택형 하위문항이 아닙니다')]);
  });

  it('choice_answer 규칙의 하위문항에 정답 메타 정답이 없으면 찾는다', () => {
    // Arrange
    const f = fixture();
    const answerKey = answerKeyOf(f, 'hr-survey');
    answerKey.choiceAnswers = withoutKey(answerKey.choiceAnswers, '1-1');

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.judgment.rules.0.subquestion', '정답 메타에 이 하위문항의 정답이 없습니다')]);
  });

  it('columns_sent 규칙이 정답 메타에 지문 정의가 없는 컬럼을 쓰면 찾는다', () => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'hr-survey'), 'judgment', 1, 'columns_sent').columns.push('사번');

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.judgment.rules.1.columns', "정답 메타에 컬럼 '사번'의 지문 정의가 없습니다")]);
  });

  it('columns_withheld 규칙이 정답 메타에 없는 자료를 쓰면 찾는다', () => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'hr-survey'), 'judgment', 2, 'columns_withheld').material = 'no-material';

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.judgment.rules.2.material', "정답 메타에 CSV 자료 'no-material'가 없습니다")]);
  });

  it('rows_withheld 규칙이 정답 메타에 없는 행을 쓰면 찾는다', () => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'hr-survey'), 'judgment', 4, 'rows_withheld').rows = ['row-injection', 'row-ghost'];

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.judgment.rules.4.rows', "정답 메타에 행 'row-ghost'가 없습니다")]);
  });

  it('rows_withheld 규칙이 정답 메타에 없는 자료를 쓰면 행 대조 없이 자료 문제만 알려준다', () => {
    // Arrange
    const f = fixture();
    const rule = ruleOf(rubricOf(f, 'hr-survey'), 'judgment', 4, 'rows_withheld');
    rule.material = 'no-material';
    rule.rows = ['row-ghost'];

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.judgment.rules.4.material', "정답 메타에 CSV 자료 'no-material'가 없습니다")]);
  });

  it.each([
    ['없는 자료', 'no-material'],
    ['CSV 자료', 'expenses'],
  ])('pages_withheld 규칙이 %s를 가리키면 PDF 자료가 없다고 알려준다', (_label, material) => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'travel-expense'), 'judgment', 1, 'pages_withheld').material = material;

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([
      issue('rubrics/travel-expense.json', 'axes.judgment.rules.1.material', `정답 메타에 PDF 자료 '${material}'가 없습니다`),
    ]);
  });

  it('pages_withheld 규칙이 정답 메타에 없는 페이지를 쓰면 찾는다', () => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'travel-expense'), 'judgment', 1, 'pages_withheld').pages = ['page-3', 'page-9'];

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/travel-expense.json', 'axes.judgment.rules.1.pages', "정답 메타에 페이지 'page-9'가 없습니다")]);
  });

  it('patterns_absent 규칙이 grading.json에 없는 패턴을 쓰면 찾는다', () => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'hr-survey'), 'judgment', 5, 'patterns_absent').patterns = ['rrn', 'ghost-pattern'];

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.judgment.rules.5.patterns', "grading.json에 패턴 'ghost-pattern'가 없습니다")]);
  });

  it('answer_revised_after_notice 규칙이 없는 하위문항을 가리키면 찾는다', () => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'hr-survey'), 'usage', 0, 'answer_revised_after_notice').subquestion = '9-9';

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.usage.rules.0.subquestion', "이 Case에 하위문항 '9-9'이 없습니다")]);
  });

  it.each([
    ['선택형 하위문항', '1-1'],
    ['없는 하위문항', '9-9'],
  ])('numeric_value 규칙이 %s을 가리키면 찾는다', (_label, subquestion) => {
    // Arrange
    const f = fixture();
    ruleOf(rubricOf(f, 'hr-survey'), 'output', 0, 'numeric_value').subquestion = subquestion;

    // Act
    const issues = validate(f);

    // Assert
    expect(issues).toEqual([issue('rubrics/hr-survey.json', 'axes.output.rules.0.subquestion', '이 Case의 서술형 하위문항이 아닙니다')]);
  });
});
