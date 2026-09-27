import { describe, expect, it } from 'vitest';
import {
  crossValidatePackage,
  examDefinitionSchema,
  rubricSchema,
  type PackageParts,
} from '@ai-measurement/shared';
import { loadExamPackage } from '@ai-measurement/shared/node';
import { loadSamplePackage, repoRoot } from './sample-package';

async function sampleParts(): Promise<{ parts: PackageParts; facts: Awaited<ReturnType<typeof loadSamplePackage>>['materialFacts'] }> {
  const pkg = await loadSamplePackage();
  const parts: PackageParts = structuredClone({
    definition: pkg.definition,
    grading: pkg.grading,
    rubrics: pkg.rubrics,
    answerKeys: pkg.answerKeys,
  });
  return { parts, facts: pkg.materialFacts };
}

describe('시험 패키지 검증', () => {
  it('샘플 패키지는 스키마와 교차 검증을 모두 통과한다', async () => {
    const pkg = await loadSamplePackage();
    expect(pkg.definition.cases).toHaveLength(3);
    expect(pkg.packageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(pkg.materialFiles).sort()).toEqual(['employees', 'expenses', 'travel-policy', 'voc']);
  });

  it('세 축 가중치 합이 100이 아니면 거부한다', async () => {
    const { parts } = await sampleParts();
    const result = examDefinitionSchema.safeParse({ ...parts.definition, axisWeights: { judgment: 30, usage: 30, output: 30 } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('100');
  });

  it('루브릭 배점 합이 max와 다르면 거부한다', async () => {
    const { parts } = await sampleParts();
    const rubric = structuredClone(parts.rubrics['hr-survey']);
    if (rubric === undefined) throw new Error('샘플 루브릭 없음');
    rubric.axes.judgment.max = 31;
    expect(rubricSchema.safeParse(rubric).success).toBe(false);
  });

  it('정의되지 않은 필드는 거부한다(오타 방지)', async () => {
    const { parts } = await sampleParts();
    const result = examDefinitionSchema.safeParse({ ...parts.definition, tokenBugdet: 1 });
    expect(result.success).toBe(false);
  });

  it('하위문항 key 중복을 찾는다', async () => {
    const { parts, facts } = await sampleParts();
    const second = parts.definition.cases[1];
    const firstSub = parts.definition.cases[0]?.subquestions[0];
    if (second === undefined || firstSub === undefined) throw new Error('샘플 구조가 예상과 다릅니다');
    second.subquestions.push({ ...firstSub });
    const issues = crossValidatePackage(parts, facts);
    expect(issues.some((i) => i.message.includes('하위문항 key') && i.message.includes('중복'))).toBe(true);
  });

  it('grading.json에 없는 태그를 쓰면 찾는다', async () => {
    const { parts, facts } = await sampleParts();
    const key = parts.answerKeys['hr-survey']?.materials['employees'];
    if (key?.kind !== 'csv') throw new Error('샘플 구조가 예상과 다릅니다');
    const column = key.columns['성명'];
    if (column === undefined) throw new Error('샘플 구조가 예상과 다릅니다');
    column.tags = ['secret-tag'];
    const issues = crossValidatePackage(parts, facts);
    expect(issues).toContainEqual(expect.objectContaining({ file: 'answer-keys/hr-survey.json', message: expect.stringContaining('secret-tag') }));
  });

  it('행 조건이 CSV에서 정확히 한 행과 맞지 않으면 찾는다', async () => {
    const { parts, facts } = await sampleParts();
    const key = parts.answerKeys['hr-survey']?.materials['employees'];
    if (key?.kind !== 'csv' || key.rows[0] === undefined) throw new Error('샘플 구조가 예상과 다릅니다');
    key.rows[0].match = { column: '부서', value: '영업1팀' };
    const issues = crossValidatePackage(parts, facts);
    expect(issues.some((i) => i.message.includes('정확히 1개'))).toBe(true);
  });

  it('CSV 헤더에 없는 컬럼을 정답 메타에 쓰면 찾는다', async () => {
    const { parts, facts } = await sampleParts();
    const key = parts.answerKeys['customer-voc']?.materials['voc'];
    if (key?.kind !== 'csv') throw new Error('샘플 구조가 예상과 다릅니다');
    key.columns['없는컬럼'] = { label: 'x', tags: ['pii'], fingerprint: { type: 'cell_values', minLength: 3 } };
    const issues = crossValidatePackage(parts, facts);
    expect(issues.some((i) => i.path.endsWith('없는컬럼') && i.message.includes('헤더'))).toBe(true);
  });

  it('PDF 쪽수를 넘는 페이지를 찾는다', async () => {
    const { parts, facts } = await sampleParts();
    const key = parts.answerKeys['travel-expense']?.materials['travel-policy'];
    if (key?.kind !== 'pdf' || key.pages[0] === undefined) throw new Error('샘플 구조가 예상과 다릅니다');
    key.pages[0].page = 99;
    const issues = crossValidatePackage(parts, facts);
    expect(issues.some((i) => i.message.includes('쪽까지'))).toBe(true);
  });

  it('규칙이 없는 공지를 가리키면 찾는다', async () => {
    const { parts, facts } = await sampleParts();
    const rule = parts.rubrics['hr-survey']?.axes.usage.rules[0];
    if (rule?.type !== 'answer_revised_after_notice') throw new Error('샘플 구조가 예상과 다릅니다');
    rule.notice = 'no-such-notice';
    const issues = crossValidatePackage(parts, facts);
    expect(issues.some((i) => i.message.includes('no-such-notice'))).toBe(true);
  });

  it('공지가 자기 자신이 여는 하위문항을 조건으로 삼으면 찾는다', async () => {
    const { parts, facts } = await sampleParts();
    const travel = parts.definition.cases.find((c) => c.key === 'travel-expense');
    const notice = travel?.notices[0];
    if (notice === undefined) throw new Error('샘플 구조가 예상과 다릅니다');
    notice.reveal = { after: 'subquestion_submitted', subquestion: '3-5' };
    const issues = crossValidatePackage(parts, facts);
    expect(issues.some((i) => i.message.includes('자기 자신'))).toBe(true);
  });

  it('없는 폴더는 문제 목록으로 돌려준다', async () => {
    const result = await loadExamPackage(`${repoRoot}/exams/does-not-exist`);
    expect(result.ok).toBe(false);
  });
});
