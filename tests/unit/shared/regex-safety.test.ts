import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadExamPackage, unsafeRegexReason } from '@ai-measurement/shared/node';
import { repoRoot, samplePackageDir } from './sample-package';

let tempRoot: string | null = null;
afterEach(async () => {
  if (tempRoot !== null) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('탐지 정규식 ReDoS 검사', () => {
  it('지수·다항식 역추적 위험이 있는 정규식을 거부한다', async () => {
    expect(await unsafeRegexReason('(a+)+b')).toContain('지수');
    expect(await unsafeRegexReason('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}')).toContain('다항식');
  }, 60_000);

  it('샘플 시험의 패턴은 안전하다', async () => {
    expect(await unsafeRegexReason('(?<!\\d)\\d{6}-[1-4]\\d{6}(?!\\d)')).toBeNull();
  }, 60_000);

  it('위험한 패턴이 든 패키지는 등록 전 검증에서 막힌다', async () => {
    tempRoot = await mkdtemp(path.join(repoRoot, 'workspace', 'regex-test-'));
    const dir = path.join(tempRoot, 'sample-ai-practice');
    await cp(samplePackageDir, dir, { recursive: true });
    const gradingPath = path.join(dir, 'grading.json');
    const grading = JSON.parse(await readFile(gradingPath, 'utf8')) as { patterns: Array<{ regex: string }> };
    grading.patterns[0]!.regex = '(\\d+)+x';
    await writeFile(gradingPath, JSON.stringify(grading));
    const result = await loadExamPackage(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ file: 'grading.json', path: 'patterns.0.regex' }));
  }, 60_000);
});
