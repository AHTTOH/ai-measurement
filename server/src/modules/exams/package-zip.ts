import { MATERIAL_FILE_PATTERN, type PackageIssue } from '@ai-measurement/shared';
import { unzipSync } from 'fflate';
import { appErrors } from '../../lib/app-error';

/** zip 안에서 허용하는 패키지 파일 경로. 이 밖의 파일이 있으면 거부한다 */
const ALLOWED_PATHS: readonly RegExp[] = [
  /^exam\.json$/u,
  /^grading\.json$/u,
  /^rubrics\/[a-z0-9][a-z0-9-]*\.json$/u,
  /^answer-keys\/[a-z0-9][a-z0-9-]*\.json$/u,
  MATERIAL_FILE_PATTERN,
];

export interface ExtractedPackage {
  files: Map<string, Uint8Array>;
}

function commonTopFolder(names: readonly string[]): string | null {
  if (names.includes('exam.json')) return null;
  const firstSegments = new Set(names.map((n) => n.split('/')[0]));
  if (firstSegments.size !== 1) return null;
  const [top] = [...firstSegments];
  return top !== undefined && names.every((n) => n.startsWith(`${top}/`)) ? `${top}/` : null;
}

/**
 * 시험 패키지 zip을 메모리에서 푼다.
 * 압축 해제 총량 제한(zip bomb 방지), 경로 조작 차단, 허용 경로 검사를 한다.
 */
export function extractPackageZip(bytes: Uint8Array, maxUncompressedBytes: number): ExtractedPackage {
  let declaredTotal = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        declaredTotal += file.originalSize;
        if (declaredTotal > maxUncompressedBytes) {
          throw appErrors.payloadTooLarge('압축을 푼 크기가 업로드 한도를 넘습니다');
        }
        return !file.name.endsWith('/');
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') throw error;
    throw appErrors.badRequest('invalid_zip', `zip 파일을 열 수 없습니다: ${(error as Error).message}`);
  }

  const actualTotal = Object.values(entries).reduce((acc, data) => acc + data.byteLength, 0);
  if (actualTotal > maxUncompressedBytes) throw appErrors.payloadTooLarge('압축을 푼 크기가 업로드 한도를 넘습니다');

  const names = Object.keys(entries).filter((n) => !n.startsWith('__MACOSX/'));
  const prefix = commonTopFolder(names);
  const files = new Map<string, Uint8Array>();
  const issues: PackageIssue[] = [];
  for (const name of names) {
    const relative = prefix !== null ? name.slice(prefix.length) : name;
    const data = entries[name];
    if (data === undefined) continue;
    const unsafe = relative.includes('\\') || relative.split('/').some((segment) => segment === '..' || segment === '') || relative.startsWith('/');
    if (unsafe || !ALLOWED_PATHS.some((pattern) => pattern.test(relative))) {
      issues.push({ file: relative, path: '', message: '시험 패키지에 들어갈 수 없는 경로입니다' });
      continue;
    }
    files.set(relative, data);
  }
  if (issues.length > 0) throw appErrors.unprocessable('invalid_package_layout', '허용되지 않는 파일이 들어 있습니다', issues);
  if (!files.has('exam.json')) throw appErrors.unprocessable('invalid_package_layout', 'exam.json이 없습니다');
  return { files };
}
