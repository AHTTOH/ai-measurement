/**
 * 시험 패키지 폴더를 등록 전에 검증한다(스키마, 파일 간 참조, 자료 파일 내용).
 * 실행: npx tsx scripts/validate-exam-package.ts exams/<slug>
 */
import { loadExamPackage } from '@ai-measurement/shared/node';

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write('검증할 패키지 폴더를 지정하십시오. 예: exams/sample-ai-practice\n');
  process.exit(1);
}
const result = await loadExamPackage(dir);
if (!result.ok) {
  process.stderr.write(`문제 ${result.issues.length}건\n`);
  for (const issue of result.issues) process.stderr.write(`- ${issue.file} ${issue.path}: ${issue.message}\n`);
  process.exit(1);
}
const { definition } = result.pkg;
process.stdout.write(`통과: ${definition.title} (Case ${definition.cases.length}개, 하위문항 ${definition.cases.reduce((n, c) => n + c.subquestions.length, 0)}개)\n`);
process.stdout.write(`패키지 해시 ${result.pkg.packageSha256}\n`);
