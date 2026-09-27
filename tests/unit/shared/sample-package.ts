import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExamPackage, type LoadedExamPackage } from '@ai-measurement/shared/node';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const samplePackageDir = path.join(repoRoot, 'exams', 'sample-ai-practice');

/** 테스트용: 샘플 패키지를 읽는다. 샘플이 없거나 깨졌으면 테스트를 실패시킨다. */
export async function loadSamplePackage(): Promise<LoadedExamPackage> {
  const result = await loadExamPackage(samplePackageDir);
  if (!result.ok) {
    throw new Error(`샘플 패키지 검증 실패. scripts/build-sample-exam-package.ts로 다시 만드십시오:\n${JSON.stringify(result.issues, null, 2)}`);
  }
  return result.pkg;
}
