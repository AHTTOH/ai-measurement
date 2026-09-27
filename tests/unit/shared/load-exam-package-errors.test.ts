import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageIssue } from '@ai-measurement/shared';
import { loadExamPackage, sha256Hex, type ExamPackageLoadResult } from '@ai-measurement/shared/node';
import { samplePackageDir } from './sample-package';

/**
 * loadExamPackage의 오류 경로. 샘플 패키지를 OS 임시 폴더에 복사한 뒤 파일을 고쳐 읽는다.
 * 원본 exams/ 폴더는 건드리지 않는다.
 */

const SAMPLE_SLUG = path.basename(samplePackageDir);
/** 첫 로드에서 탐지 정규식 ReDoS 검사(recheck 워커)가 돌아 시간이 걸린다 */
const LOAD_TIMEOUT_MS = 60_000;

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

/** 샘플 패키지를 임시 폴더 아래 folderName으로 복사하고 그 경로를 돌려준다 */
async function copySample(folderName: string = SAMPLE_SLUG): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-measurement-load-'));
  const dir = path.join(tempRoot, folderName);
  await cp(samplePackageDir, dir, { recursive: true });
  return dir;
}

async function writeUtf8(dir: string, relativePath: string, content: string): Promise<void> {
  await writeFile(path.join(dir, relativePath), content, { encoding: 'utf8' });
}

async function editJson(dir: string, relativePath: string, edit: (json: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const original = JSON.parse(await readFile(path.join(dir, relativePath), { encoding: 'utf8' })) as Record<string, unknown>;
  await writeUtf8(dir, relativePath, JSON.stringify(edit(original)));
}

function issuesOf(result: ExamPackageLoadResult): PackageIssue[] {
  if (result.ok) throw new Error('검증 실패를 기대했지만 패키지가 통과했습니다');
  return result.issues;
}

function issue(file: string, issuePath: string, message: string): PackageIssue {
  return { file, path: issuePath, message };
}

describe('시험 패키지 읽기: 폴더', () => {
  it('폴더가 아닌 경로는 거부한다', async () => {
    // Arrange
    const filePath = path.join(samplePackageDir, 'exam.json');

    // Act
    const result = await loadExamPackage(filePath);

    // Assert
    expect(issuesOf(result)).toEqual([issue('', '', `폴더가 아닙니다: ${path.resolve(filePath)}`)]);
  });

  it('폴더 이름과 slug가 다르면 찾는다', async () => {
    // Arrange
    const dir = await copySample('renamed-exam');

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    expect(issuesOf(result)).toEqual([issue('exam.json', 'slug', 'slug(sample-ai-practice)가 폴더 이름(renamed-exam)과 같아야 합니다')]);
  }, LOAD_TIMEOUT_MS);
});

describe('시험 패키지 읽기: 정의 파일', () => {
  it('exam.json이 없으면 그것만 보고하고 멈춘다', async () => {
    // Arrange
    const dir = await copySample();
    await rm(path.join(dir, 'exam.json'));

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    expect(issuesOf(result)).toEqual([issue('exam.json', '', '파일이 없습니다')]);
  });

  it('grading.json이 없으면 그것만 보고하고 멈춘다', async () => {
    // Arrange
    const dir = await copySample();
    await rm(path.join(dir, 'grading.json'));

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    expect(issuesOf(result)).toEqual([issue('grading.json', '', '파일이 없습니다')]);
  });

  it('파일 자리에 폴더가 있으면 읽기 오류로 보고한다', async () => {
    // Arrange
    const dir = await copySample();
    await rm(path.join(dir, 'exam.json'));
    await mkdir(path.join(dir, 'exam.json'));

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    const issues = issuesOf(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'exam.json', path: '' });
    expect(issues[0]?.message).toMatch(/^파일을 읽지 못했습니다: /u);
  });

  it('JSON 문법 오류를 보고한다', async () => {
    // Arrange
    const dir = await copySample();
    await writeUtf8(dir, 'grading.json', '{ "schemaVersion": 1,');

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    const issues = issuesOf(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'grading.json', path: '' });
    expect(issues[0]?.message).toMatch(/^JSON 형식 오류: /u);
  });

  it('스키마 위반은 파일 안 위치와 함께 보고한다', async () => {
    // Arrange
    const dir = await copySample();
    await editJson(dir, 'exam.json', (json) => ({ ...json, durationMinutes: 0 }));

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    const issues = issuesOf(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'exam.json', path: 'durationMinutes' });
  });

  it('UTF-8 BOM으로 시작하는 JSON도 읽는다', async () => {
    // Arrange
    const dir = await copySample();
    const examPath = path.join(dir, 'exam.json');
    const utf8Bom = String.fromCodePoint(0xfeff);
    await writeFile(examPath, `${utf8Bom}${await readFile(examPath, { encoding: 'utf8' })}`, { encoding: 'utf8' });

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    expect(result.ok).toBe(true);
  }, LOAD_TIMEOUT_MS);
});

describe('시험 패키지 읽기: 루브릭·정답 메타 폴더', () => {
  it('Case와 대응하지 않는 파일을 찾는다', async () => {
    // Arrange
    const dir = await copySample();
    await writeUtf8(dir, 'rubrics/notes.txt', '메모');
    await writeUtf8(dir, 'answer-keys/ghost.json', '{}');

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    const message = 'exam.json의 Case와 대응하지 않는 파일입니다';
    expect(issuesOf(result)).toEqual([issue('rubrics/notes.txt', '', message), issue('answer-keys/ghost.json', '', message)]);
  }, LOAD_TIMEOUT_MS);

  it('루브릭 폴더와 정답 메타 파일이 없으면 Case별로 없는 파일을 모두 보고한다', async () => {
    // Arrange
    const dir = await copySample();
    await rm(path.join(dir, 'rubrics'), { recursive: true });
    await rm(path.join(dir, 'answer-keys', 'customer-voc.json'));

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    const missing = '파일이 없습니다';
    expect(issuesOf(result)).toEqual([
      issue('rubrics/hr-survey.json', '', missing),
      issue('rubrics/customer-voc.json', '', missing),
      issue('answer-keys/customer-voc.json', '', missing),
      issue('rubrics/travel-expense.json', '', missing),
    ]);
  }, LOAD_TIMEOUT_MS);
});

describe('시험 패키지 읽기: 자료 파일', () => {
  it('자료 파일이 없으면 보고한다', async () => {
    // Arrange
    const dir = await copySample();
    await rm(path.join(dir, 'materials', 'voc.csv'));

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    expect(issuesOf(result)).toEqual([issue('materials/voc.csv', '', '파일이 없습니다')]);
  }, LOAD_TIMEOUT_MS);

  it('CSV 형식 오류를 자료 파일 문제로 보고한다', async () => {
    // Arrange
    const dir = await copySample();
    await writeUtf8(dir, 'materials/employees.csv', '사번,사번\nE1,E2\n');

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    expect(issuesOf(result)).toEqual([issue('materials/employees.csv', '', '헤더 이름이 중복됩니다')]);
  }, LOAD_TIMEOUT_MS);

  it('열 수 없는 PDF를 보고한다', async () => {
    // Arrange
    const dir = await copySample();
    await writeUtf8(dir, 'materials/travel-policy.pdf', 'PDF가 아닌 텍스트');

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    const issues = issuesOf(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: 'materials/travel-policy.pdf', path: '' });
    expect(issues[0]?.message).toMatch(/^PDF를 열 수 없습니다: /u);
  }, LOAD_TIMEOUT_MS);
});

describe('시험 패키지 읽기: 교차 검증과 해시', () => {
  it('스키마는 통과했지만 교차 검증에 걸리면 교차 검증 문제만 돌려준다', async () => {
    // Arrange
    const dir = await copySample();
    await editJson(dir, 'answer-keys/hr-survey.json', (json) => ({
      ...json,
      choiceAnswers: { '1-1': ['name', 'bogus'] },
    }));

    // Act
    const result = await loadExamPackage(dir);

    // Assert
    expect(issuesOf(result)).toEqual([issue('answer-keys/hr-survey.json', 'choiceAnswers.1-1', "선택지 'bogus'가 없습니다")]);
  }, LOAD_TIMEOUT_MS);

  it('패키지 해시는 위치와 무관하고, 자료 바이트가 바뀌면 달라진다', async () => {
    // Arrange
    const dir = await copySample();
    const original = await loadExamPackage(samplePackageDir);
    const copied = await loadExamPackage(dir);
    const employeesPath = path.join(dir, 'materials', 'employees.csv');
    const employeesBytes = await readFile(employeesPath);
    await writeFile(employeesPath, Buffer.concat([employeesBytes, Buffer.from('\n', 'utf8')]));

    // Act
    const changed = await loadExamPackage(dir);

    // Assert
    if (!original.ok || !copied.ok || !changed.ok) throw new Error('세 번 모두 통과해야 합니다');
    expect(copied.pkg.packageSha256).toBe(original.pkg.packageSha256);
    expect(copied.pkg.dir).toBe(path.resolve(dir));
    expect(copied.pkg.materialFiles['employees']).toEqual({
      key: 'employees',
      kind: 'csv',
      file: 'materials/employees.csv',
      sha256: sha256Hex(employeesBytes),
      byteLength: employeesBytes.byteLength,
    });
    expect(changed.pkg.packageSha256).not.toBe(original.pkg.packageSha256);
    expect(changed.pkg.materialFiles['employees']?.byteLength).toBe(employeesBytes.byteLength + 1);
  }, LOAD_TIMEOUT_MS);
});
