/**
 * 샘플 시험 패키지(exams/sample-ai-practice)를 처음부터 다시 만든다.
 * 자료는 전부 시드 고정 난수로 만든 가공 데이터이고, 기준 수치는 만든 데이터에서 계산한다.
 * 실행: npx tsx scripts/build-sample-exam-package.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerKeyFile, rubricFile, type ExamDefinition } from '@ai-measurement/shared';
import { loadExamPackage } from '@ai-measurement/shared/node';
import type { CaseBundle, GeneratedFile } from './sample-exam-package/case-bundle';
import { buildCustomerVocCase } from './sample-exam-package/case-customer-voc';
import { buildHrSurveyCase } from './sample-exam-package/case-hr-survey';
import { buildTravelExpenseCase } from './sample-exam-package/case-travel-expense';
import { SAMPLE_EXAM_SLUG, sampleExamShell, sampleGradingConfig } from './sample-exam-package/exam-settings';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(repoRoot, 'exams', SAMPLE_EXAM_SLUG);
const fontDir = path.join(repoRoot, 'node_modules', 'pretendard', 'dist', 'public', 'static', 'alternative');

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeGenerated(files: readonly GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(packageDir, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

async function main(): Promise<void> {
  const cases: CaseBundle[] = [
    buildHrSurveyCase(),
    buildCustomerVocCase(),
    await buildTravelExpenseCase({
      regularPath: path.join(fontDir, 'Pretendard-Regular.ttf'),
      boldPath: path.join(fontDir, 'Pretendard-Bold.ttf'),
    }),
  ];
  const definition: ExamDefinition = { ...sampleExamShell(), cases: cases.map((c) => c.caseDef) };

  // 생성물 폴더만 지우고 다시 만든다. 경로가 예상과 다르면 멈춘다.
  if (path.basename(packageDir) !== SAMPLE_EXAM_SLUG || path.basename(path.dirname(packageDir)) !== 'exams') {
    throw new Error(`예상하지 못한 출력 경로입니다: ${packageDir}`);
  }
  await rm(packageDir, { recursive: true, force: true });

  await writeGenerated([
    { relativePath: 'exam.json', content: json(definition) },
    { relativePath: 'grading.json', content: json(sampleGradingConfig()) },
    ...cases.flatMap((c) => [
      { relativePath: rubricFile(c.caseDef.key), content: json(c.rubric) },
      { relativePath: answerKeyFile(c.caseDef.key), content: json(c.answerKey) },
      ...c.files,
    ]),
  ]);

  const result = await loadExamPackage(packageDir);
  if (!result.ok) {
    console.error('생성한 패키지가 검증을 통과하지 못했습니다:');
    for (const issue of result.issues) console.error(`- ${issue.file} ${issue.path}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`샘플 시험 패키지를 만들었습니다: ${packageDir}`);
  console.log(`패키지 해시: ${result.pkg.packageSha256}`);
}

await main();
