import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadExamPackage } from '@ai-measurement/shared/node';
import { samplePackageDir } from './sample-package';

/**
 * CSV 파서가 CsvFormatError가 아닌 예외를 던지면 패키지 문제로 삼키지 않고 그대로 올려보내는지 확인한다.
 * parseCsvText를 감싸는 모듈 모의가 필요해서 다른 테스트와 파일을 나눈다.
 */

const csvParser = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('../../../shared/src/node/csv-table', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/src/node/csv-table')>();
  return {
    ...actual,
    parseCsvText: (text: string) => {
      if (csvParser.failure !== null) throw csvParser.failure;
      return actual.parseCsvText(text);
    },
  };
});

afterEach(() => {
  csvParser.failure = null;
});

describe('시험 패키지 읽기: 예상하지 못한 오류', () => {
  it('모의 파서가 정상일 때는 샘플 패키지를 그대로 읽는다', async () => {
    // Arrange
    csvParser.failure = null;

    // Act
    const result = await loadExamPackage(samplePackageDir);

    // Assert
    expect(result.ok).toBe(true);
  }, 60_000);

  it('CSV 형식 오류가 아닌 예외는 문제 목록으로 바꾸지 않고 던진다', async () => {
    // Arrange
    const unexpected = new TypeError('예상하지 못한 파서 오류');
    csvParser.failure = unexpected;

    // Act
    const loading = loadExamPackage(samplePackageDir);

    // Assert
    await expect(loading).rejects.toBe(unexpected);
  }, 60_000);
});
