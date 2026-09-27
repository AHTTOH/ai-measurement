import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { z } from 'zod';
import { type PackageIssue, zodIssuesToPackageIssues } from '../exam-package/common-schema';
import {
  EXAM_FILE,
  GRADING_FILE,
  answerKeyFile,
  crossValidatePackage,
  rubricFile,
  type PackageParts,
} from '../exam-package/cross-validate';
import { examDefinitionSchema, type MaterialKind } from '../exam-package/exam-definition-schema';
import { answerKeySchema, gradingConfigSchema, rubricSchema, type AnswerKey, type Rubric } from '../exam-package/grading-schema';
import type { MaterialFacts } from '../exam-package/material-facts';
import { CsvFormatError, parseCsvText } from './csv-table';
import { unsafeRegexReason } from './regex-safety';

export interface MaterialFileInfo {
  key: string;
  kind: MaterialKind;
  /** 패키지 루트 기준 상대 경로 */
  file: string;
  sha256: string;
  byteLength: number;
}

export interface LoadedExamPackage extends PackageParts {
  /** 패키지 폴더의 절대 경로 */
  dir: string;
  /** 모든 정의 파일과 자료 파일 해시를 묶은 패키지 해시 */
  packageSha256: string;
  materialFiles: Record<string, MaterialFileInfo>;
  materialFacts: Record<string, MaterialFacts>;
}

export type ExamPackageLoadResult =
  | { ok: true; pkg: LoadedExamPackage }
  | { ok: false; issues: PackageIssue[] };

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface FileRead {
  bytes: Buffer;
  sha256: string;
}

class PackageReader {
  readonly issues: PackageIssue[] = [];
  readonly fileHashes = new Map<string, string>();

  constructor(readonly dir: string) {}

  async readBytes(relativePath: string): Promise<FileRead | undefined> {
    try {
      const bytes = await readFile(path.join(this.dir, relativePath));
      const sha256 = sha256Hex(bytes);
      this.fileHashes.set(relativePath, sha256);
      return { bytes, sha256 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.issues.push({ file: relativePath, path: '', message: code === 'ENOENT' ? '파일이 없습니다' : `파일을 읽지 못했습니다: ${(error as Error).message}` });
      return undefined;
    }
  }

  async readValidated<T>(relativePath: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const read = await this.readBytes(relativePath);
    if (read === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(read.bytes.toString('utf8').replace(/^﻿/u, ''));
    } catch (error) {
      this.issues.push({ file: relativePath, path: '', message: `JSON 형식 오류: ${(error as Error).message}` });
      return undefined;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      this.issues.push(...zodIssuesToPackageIssues(relativePath, parsed.error));
      return undefined;
    }
    return parsed.data;
  }

  async reportUnexpectedJsonFiles(folder: string, expectedKeys: ReadonlySet<string>): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(path.join(this.dir, folder));
    } catch {
      return; // 폴더가 없으면 개별 파일 읽기에서 '파일이 없습니다'로 보고된다
    }
    for (const entry of entries) {
      const key = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : undefined;
      if (key === undefined || !expectedKeys.has(key)) {
        this.issues.push({ file: `${folder}/${entry}`, path: '', message: 'exam.json의 Case와 대응하지 않는 파일입니다' });
      }
    }
  }
}

async function readMaterialFacts(reader: PackageReader, kind: MaterialKind, file: string): Promise<{ facts: MaterialFacts; read: FileRead } | undefined> {
  const read = await reader.readBytes(file);
  if (read === undefined) return undefined;
  if (kind === 'csv') {
    try {
      return { facts: { kind: 'csv', table: parseCsvText(read.bytes.toString('utf8')) }, read };
    } catch (error) {
      if (error instanceof CsvFormatError) {
        reader.issues.push({ file, path: '', message: error.message });
        return undefined;
      }
      throw error;
    }
  }
  try {
    const pdf = await PDFDocument.load(read.bytes, { updateMetadata: false });
    return { facts: { kind: 'pdf', pageCount: pdf.getPageCount() }, read };
  } catch (error) {
    reader.issues.push({ file, path: '', message: `PDF를 열 수 없습니다: ${(error as Error).message}` });
    return undefined;
  }
}

function computePackageHash(fileHashes: ReadonlyMap<string, string>): string {
  const entries = [...fileHashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(JSON.stringify(entries));
}

/**
 * exams/<slug>/ 폴더의 시험 패키지를 읽고 스키마·교차 검증을 모두 수행한다.
 * 문제가 하나라도 있으면 ok:false와 전체 문제 목록을 돌려준다.
 */
export async function loadExamPackage(packageDir: string): Promise<ExamPackageLoadResult> {
  const dir = path.resolve(packageDir);
  try {
    if (!(await stat(dir)).isDirectory()) {
      return { ok: false, issues: [{ file: '', path: '', message: `폴더가 아닙니다: ${dir}` }] };
    }
  } catch {
    return { ok: false, issues: [{ file: '', path: '', message: `폴더가 없습니다: ${dir}` }] };
  }

  const reader = new PackageReader(dir);
  const definition = await reader.readValidated(EXAM_FILE, examDefinitionSchema);
  const grading = await reader.readValidated(GRADING_FILE, gradingConfigSchema);
  if (definition === undefined || grading === undefined) return { ok: false, issues: reader.issues };

  for (const [index, pattern] of grading.patterns.entries()) {
    const reason = await unsafeRegexReason(pattern.regex);
    if (reason !== null) reader.issues.push({ file: GRADING_FILE, path: `patterns.${index}.regex`, message: reason });
  }

  if (definition.slug !== path.basename(dir)) {
    reader.issues.push({ file: EXAM_FILE, path: 'slug', message: `slug(${definition.slug})가 폴더 이름(${path.basename(dir)})과 같아야 합니다` });
  }

  const caseKeys = new Set(definition.cases.map((c) => c.key));
  await reader.reportUnexpectedJsonFiles('rubrics', caseKeys);
  await reader.reportUnexpectedJsonFiles('answer-keys', caseKeys);

  const rubrics: Record<string, Rubric> = {};
  const answerKeys: Record<string, AnswerKey> = {};
  const materialFiles: Record<string, MaterialFileInfo> = {};
  const materialFacts: Record<string, MaterialFacts> = {};

  for (const caseDef of definition.cases) {
    const rubric = await reader.readValidated(rubricFile(caseDef.key), rubricSchema);
    if (rubric !== undefined) rubrics[caseDef.key] = rubric;
    const answerKey = await reader.readValidated(answerKeyFile(caseDef.key), answerKeySchema);
    if (answerKey !== undefined) answerKeys[caseDef.key] = answerKey;

    for (const material of caseDef.materials) {
      const loaded = await readMaterialFacts(reader, material.kind, material.file);
      if (loaded === undefined) continue;
      materialFacts[material.key] = loaded.facts;
      materialFiles[material.key] = {
        key: material.key,
        kind: material.kind,
        file: material.file,
        sha256: loaded.read.sha256,
        byteLength: loaded.read.bytes.byteLength,
      };
    }
  }

  if (reader.issues.length > 0) return { ok: false, issues: reader.issues };

  const parts: PackageParts = { definition, grading, rubrics, answerKeys };
  const crossIssues = crossValidatePackage(parts, materialFacts);
  if (crossIssues.length > 0) return { ok: false, issues: crossIssues };

  return {
    ok: true,
    pkg: {
      ...parts,
      dir,
      packageSha256: computePackageHash(reader.fileHashes),
      materialFiles,
      materialFacts,
    },
  };
}
