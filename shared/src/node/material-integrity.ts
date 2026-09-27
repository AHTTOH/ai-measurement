import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MATERIAL_FILE_PATTERN } from '../exam-package/exam-definition-schema';
import { sha256Hex } from './load-exam-package';

export class MaterialIntegrityError extends Error {
  override readonly name = 'MaterialIntegrityError';
}

export interface MaterialFileRef {
  file: string;
  sha256: string;
}

/**
 * 등록 당시 해시와 같은지 확인하고 자료 파일을 읽는다.
 * 파일이 바뀌었거나 없으면 예외를 던진다. 다른 내용으로 대신하지 않는다.
 */
export async function readVerifiedMaterial(packageDir: string, ref: MaterialFileRef): Promise<Buffer> {
  if (!MATERIAL_FILE_PATTERN.test(ref.file)) {
    throw new MaterialIntegrityError(`허용되지 않는 자료 경로입니다: ${ref.file}`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(packageDir, ref.file));
  } catch (error) {
    throw new MaterialIntegrityError(`자료 파일을 읽지 못했습니다(${ref.file}): ${(error as Error).message}`);
  }
  const actual = sha256Hex(bytes);
  if (actual !== ref.sha256) {
    throw new MaterialIntegrityError(`자료 파일이 등록 이후 바뀌었습니다(${ref.file}). 등록 해시 ${ref.sha256.slice(0, 12)}, 현재 ${actual.slice(0, 12)}`);
  }
  return bytes;
}
