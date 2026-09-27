import { beforeAll, describe, expect, it } from 'vitest';
import { crossValidatePackage, type CaseDefinition, type MaterialFacts, type PackageParts } from '@ai-measurement/shared';
import { CsvSelectionError, selectCsv } from '@ai-measurement/shared/node';
import type { LoadedExamPackage } from '@ai-measurement/shared/node';
import { loadSamplePackage } from './sample-package';

/** 2026-09-27 테스트 작성 중 발견한 두 결함의 회귀 테스트 */

let sample: LoadedExamPackage;

beforeAll(async () => {
  sample = await loadSamplePackage();
}, 120_000);

function copyParts(): { parts: PackageParts; facts: Record<string, MaterialFacts> } {
  return structuredClone({
    parts: { definition: sample.definition, grading: sample.grading, rubrics: sample.rubrics, answerKeys: sample.answerKeys },
    facts: sample.materialFacts,
  });
}

describe('공지 순환', () => {
  it('두 공지가 서로가 여는 하위문항을 기다리면 두 하위문항 모두 열리지 않는다고 알린다', () => {
    // Arrange: 첫 Case의 하위문항 둘을 골라 서로 다른 공지가 열게 하고, 각 공지는 상대가 여는 하위문항 제출을 기다리게 한다
    const { parts, facts } = copyParts();
    const caseDef = parts.definition.cases[0] as CaseDefinition;
    const [first, second] = caseDef.subquestions.slice(-2);
    const [template] = caseDef.notices;
    if (first === undefined || second === undefined || template === undefined) throw new Error('샘플 구조가 예상과 다릅니다');
    const noticeA = { ...structuredClone(template), key: 'cycle-a', reveal: { after: 'subquestion_submitted' as const, subquestion: second.key } };
    const noticeB = { ...structuredClone(template), key: 'cycle-b', reveal: { after: 'subquestion_submitted' as const, subquestion: first.key } };
    caseDef.notices.push(noticeA, noticeB);
    first.unlockedByNotice = 'cycle-a';
    second.unlockedByNotice = 'cycle-b';

    // Act
    const issues = crossValidatePackage(parts, facts).filter((i) => i.message.includes('서로를 기다려'));

    // Assert
    expect(issues.map((i) => i.message)).toEqual([
      `공지와 하위문항이 서로를 기다려 하위문항 '${first.key}'이 열리지 않습니다`,
      `공지와 하위문항이 서로를 기다려 하위문항 '${second.key}'이 열리지 않습니다`,
    ]);
  });

  it('샘플 패키지에는 순환이 없다', () => {
    const { parts, facts } = copyParts();
    expect(crossValidatePackage(parts, facts)).toEqual([]);
  });
});

describe('CSV 선택', () => {
  it('칸 수가 모자란 행은 빈 값으로 메우지 않고 오류를 낸다', () => {
    const table = { headers: ['이름', '부서'], rows: [['김', '영업'], ['이']] };
    expect(() => selectCsv(table, { columns: ['부서'], rowIndexes: [1] })).toThrow(CsvSelectionError);
  });
});
