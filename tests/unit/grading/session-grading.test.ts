import { beforeAll, describe, expect, it } from 'vitest';
import { completeSession, findSevereViolations, GRADER_SYSTEM_PROMPT, prepareSession, type GradingExam, type PreparedSession } from '@ai-measurement/grading';
import type { AxisRubric, Rubric } from '@ai-measurement/shared';
// llmRequestOf는 패키지 진입점에 없는 내부 함수라 소스에서 직접 가져온다
import { llmRequestOf } from '../../../grading/src/job/session-grading';
import { sampleGradingExam, snapshotOf, userMessage } from './grading-fixtures';

/** 첫 로드에서 탐지 정규식 ReDoS 검사(recheck 워커)가 돌아 오래 걸린다. 한 번 미리 읽어 두면 이후 로드는 검사 결과 캐시를 쓴다 */
const SAMPLE_LOAD_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  await sampleGradingExam();
}, SAMPLE_LOAD_TIMEOUT_MS);

type PreparedCase = PreparedSession['cases'][number];

const RESULT_MISSING = 'LLM 채점 결과를 받지 못했습니다';

function mapAxes(rubric: Rubric, change: (axis: AxisRubric) => AxisRubric): Rubric {
  return { ...rubric, axes: { judgment: change(rubric.axes.judgment), usage: change(rubric.axes.usage), output: change(rubric.axes.output) } };
}

/** 기준(criteria)과 수치 규칙을 모두 뺀다: LLM에 맡길 항목이 없는 Case */
const ruleOnly = (axis: AxisRubric): AxisRubric => ({ ...axis, criteria: [], rules: axis.rules.filter((r) => r.type !== 'numeric_value') });
/** 기준(criteria)만 뺀다: 수치 항목만 LLM에 맡기는 Case */
const numericOnly = (axis: AxisRubric): AxisRubric => ({ ...axis, criteria: [] });

function withRubric(exam: GradingExam, caseKey: string, rubric: Rubric): GradingExam {
  return { ...exam, rubrics: { ...exam.rubrics, [caseKey]: rubric } };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function caseOf(prepared: PreparedSession, caseKey: string): PreparedCase {
  const found = prepared.cases.find((c) => c.context.caseDef.key === caseKey);
  if (found === undefined) throw new Error(`준비된 Case가 없습니다: ${caseKey}`);
  return found;
}

function llmOf(prepared: PreparedCase): NonNullable<PreparedCase['llm']> {
  if (prepared.llm === null) throw new Error(`LLM 재료가 없습니다: ${prepared.context.caseDef.key}`);
  return prepared.llm;
}

async function examWithCustomerVoc(change: (axis: AxisRubric) => AxisRubric): Promise<{ exam: GradingExam; prepared: PreparedSession }> {
  const sample = await sampleGradingExam();
  const rubric = sample.exam.rubrics['customer-voc'];
  if (rubric === undefined) throw new Error('샘플에 customer-voc 루브릭이 없습니다');
  const exam = withRubric(sample.exam, 'customer-voc', mapAxes(rubric, change));
  return { exam, prepared: prepareSession(exam, sample.materials, snapshotOf([userMessage('customer-voc', '배송 지연 VOC 분류')])) };
}

describe('세션 준비(prepareSession)', () => {
  it.each<{ label: string; breakExam: (exam: GradingExam) => GradingExam }>([
    { label: '루브릭', breakExam: (exam) => ({ ...exam, rubrics: withoutKey(exam.rubrics, 'hr-survey') }) },
    { label: '정답 메타', breakExam: (exam) => ({ ...exam, answerKeys: withoutKey(exam.answerKeys, 'hr-survey') }) },
  ])('Case의 채점 정의($label)가 없으면 준비를 멈춘다', async ({ breakExam }) => {
    // Arrange
    const { exam, materials } = await sampleGradingExam();

    // Act
    const act = () => prepareSession(breakExam(exam), materials, snapshotOf([]));

    // Assert
    expect(act).toThrow("Case 'hr-survey'의 루브릭 또는 정답 메타가 없습니다");
  });

  it('LLM에 맡길 항목이 없는 Case는 요청 재료 없이 결정적 규칙만 판정한다', async () => {
    // Act
    const { prepared } = await examWithCustomerVoc(ruleOnly);

    // Assert
    const voc = caseOf(prepared, 'customer-voc');
    expect(voc.llm).toBeNull();
    expect(voc.ruleItems.map((i) => i.itemId)).toEqual(['j2-choice', 'j2-needed', 'j2-no-contact', 'j2-no-name', 'j2-no-injection', 'j2-patterns']);
    expect(voc.ruleItems.every((i) => i.grader === 'rule' && i.status === 'graded')).toBe(true);
  });

  it('기준이 없어도 수치 항목이 있으면 LLM 요청 재료를 만든다', async () => {
    // Act
    const { prepared } = await examWithCustomerVoc(numericOnly);

    // Assert
    const llm = llmOf(caseOf(prepared, 'customer-voc'));
    expect(llm.items.criteria).toEqual([]);
    expect(llm.items.numeric.map((n) => n.id)).toEqual(['o2-delivery', 'o2-refund']);
    expect(llm.caseBlock).toContain('## 채점 기준(criteria)\n## 수치 항목(numeric)\n- id=o2-delivery');
    expect([...llm.messageRefs.keys()]).toEqual(['M1']);
  });

  it('중대 보안 위반을 같은 입력의 findSevereViolations 결과로 함께 담는다', async () => {
    // Arrange
    const { exam, materials } = await sampleGradingExam();
    const snapshot = snapshotOf([userMessage('hr-survey', '주민번호 900101-1234567 확인')]);

    // Act
    const prepared = prepareSession(exam, materials, snapshot);

    // Assert
    expect(prepared.snapshot).toBe(snapshot);
    expect(prepared.violations).toEqual(findSevereViolations(exam, materials, snapshot));
    expect(prepared.violations.map((v) => v.tag)).toContain('rrn');
  });
});

describe('LLM 요청 만들기(llmRequestOf)', () => {
  it('준비된 재료와 시험의 채점 설정으로 요청을 만든다', async () => {
    // Arrange
    const { exam, materials } = await sampleGradingExam();
    const hr = caseOf(prepareSession(exam, materials, snapshotOf([userMessage('hr-survey', '부서별 평균')])), 'hr-survey');
    const llm = llmOf(hr);

    // Act
    const request = llmRequestOf(exam, hr, 'r7');

    // Assert
    expect(request).toEqual({
      customId: 'r7',
      system: GRADER_SYSTEM_PROMPT,
      caseBlock: llm.caseBlock,
      candidateBlock: llm.candidateBlock,
      settings: exam.grading.grader,
      items: llm.items,
    });
  });

  it('LLM 항목이 없는 Case로 요청을 만들려 하면 멈춘다', async () => {
    // Arrange
    const { exam, prepared } = await examWithCustomerVoc(ruleOnly);

    // Act
    const act = () => llmRequestOf(exam, caseOf(prepared, 'customer-voc'), 'r1');

    // Assert
    expect(act).toThrow('LLM 항목이 없는 Case입니다');
  });
});

describe('세션 합산(completeSession)', () => {
  it('LLM 항목이 없는 Case는 LLM 결과를 찾지 않고 규칙 결과만 돌려준다', async () => {
    // Arrange
    const { prepared } = await examWithCustomerVoc(ruleOnly);
    const asked: string[] = [];

    // Act
    const items = completeSession(
      prepared,
      (caseKey) => {
        asked.push(caseKey);
        return undefined;
      },
      'llm-mock',
    );

    // Assert
    expect(asked).toEqual(['hr-survey', 'travel-expense']);
    expect(items.filter((i) => i.caseKey === 'customer-voc')).toEqual(caseOf(prepared, 'customer-voc').ruleItems);
  });

  it('결과를 받지 못한 Case는 LLM 항목을 0점이 아닌 미채점으로 두고 규칙 결과는 그대로 둔다', async () => {
    // Arrange
    const { exam, materials } = await sampleGradingExam();
    const prepared = prepareSession(exam, materials, snapshotOf([userMessage('hr-survey', '부서별 평균')]));
    // 샘플의 LLM 항목: hr-survey 기준 8·수치 2, customer-voc 기준 8·수치 2, travel-expense 기준 7·수치 3
    const LLM_ITEM_COUNT = 30;

    // Act
    const items = completeSession(prepared, () => undefined, 'llm');

    // Assert
    expect(items.filter((i) => i.grader === 'rule')).toEqual(prepared.cases.flatMap((c) => c.ruleItems));
    expect(items.filter((i) => i.grader === 'llm')).toMatchObject(
      Array.from({ length: LLM_ITEM_COUNT }, () => ({ earned: null, status: 'ungraded', model: null, detail: { error: RESULT_MISSING } })),
    );
  });
});
