import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tables, type Database, type MaterialFileSnapshot } from '@ai-measurement/infra';
import { KEY_PATTERN, type ExamPackageListItem } from '@ai-measurement/shared';
import { loadExamPackage, type LoadedExamPackage } from '@ai-measurement/shared/node';
import { count, eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { actorOf, writeAudit } from '../audit/audit-log';
import { extractPackageZip } from './package-zip';

const UPLOAD_STAGING_DIR = '.uploads';

function snapshotOf(pkg: LoadedExamPackage) {
  const materialFiles: Record<string, MaterialFileSnapshot> = Object.fromEntries(
    Object.entries(pkg.materialFiles).map(([key, info]) => [key, { key, kind: info.kind, file: info.file, sha256: info.sha256, byteLength: info.byteLength }]),
  );
  return {
    slug: pkg.definition.slug,
    title: pkg.definition.title,
    packageSha256: pkg.packageSha256,
    definition: pkg.definition,
    grading: pkg.grading,
    rubrics: pkg.rubrics,
    answerKeys: pkg.answerKeys,
    materialFiles,
  };
}

/** 시험 패키지 목록 조회, 검증, 등록(폴더·zip) */
export class ExamImportService {
  constructor(
    private readonly db: Database,
    private readonly examsDir: string,
    private readonly uploadMaxBytes: number,
  ) {}

  async listPackages(): Promise<ExamPackageListItem[]> {
    const entries = await readdir(this.examsDir, { withFileTypes: true });
    const imported = await this.db.select({ id: tables.exams.id, slug: tables.exams.slug }).from(tables.exams);
    const importedBySlug = new Map(imported.map((e) => [e.slug, e.id]));
    const items: ExamPackageListItem[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const result = await loadExamPackage(path.join(this.examsDir, entry.name));
      items.push({
        slug: entry.name,
        ok: result.ok,
        title: result.ok ? result.pkg.definition.title : null,
        issues: result.ok ? [] : result.issues,
        importedExamId: importedBySlug.get(entry.name) ?? null,
      });
    }
    return items.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** exams/<slug> 폴더의 패키지를 검증하고 등록한다. 같은 slug가 초안이고 응시 기록이 없으면 스냅샷을 교체한다 */
  async importDirectory(slug: string, adminId: string): Promise<{ examId: string; replaced: boolean }> {
    if (!KEY_PATTERN.test(slug)) throw appErrors.badRequest('invalid_slug', 'slug 형식이 올바르지 않습니다');
    const result = await loadExamPackage(path.join(this.examsDir, slug));
    if (!result.ok) throw appErrors.unprocessable('invalid_package', '시험 패키지 검증에 실패했습니다', result.issues);
    const snapshot = snapshotOf(result.pkg);

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: tables.exams.id, status: tables.exams.status, packageSha256: tables.exams.packageSha256 })
        .from(tables.exams)
        .where(eq(tables.exams.slug, slug))
        .for('update')
        .limit(1);
      if (existing === undefined) {
        const [created] = await tx.insert(tables.exams).values({ ...snapshot, status: 'draft', importedBy: adminId }).returning({ id: tables.exams.id });
        if (created === undefined) throw new Error('시험을 등록하지 못했습니다');
        await writeAudit(tx, { examId: created.id, examSessionId: null, actor: actorOf.admin(adminId), kind: 'exam_imported', payload: { slug, packageSha256: snapshot.packageSha256 } });
        return { examId: created.id, replaced: false };
      }
      if (existing.status !== 'draft') {
        throw appErrors.conflict('exam_not_draft', '이미 열렸거나 종료된 시험은 다시 등록할 수 없습니다. slug를 바꿔 새 시험으로 등록하십시오');
      }
      const [sessionCount] = await tx.select({ n: count() }).from(tables.examSessions).where(eq(tables.examSessions.examId, existing.id));
      if ((sessionCount?.n ?? 0) > 0) throw appErrors.conflict('exam_has_sessions', '응시 기록이 있는 시험은 다시 등록할 수 없습니다');
      await tx.update(tables.exams).set({ ...snapshot, importedBy: adminId, importedAt: new Date() }).where(eq(tables.exams.id, existing.id));
      await writeAudit(tx, {
        examId: existing.id,
        examSessionId: null,
        actor: actorOf.admin(adminId),
        kind: 'exam_reimported',
        payload: { slug, previousSha256: existing.packageSha256, packageSha256: snapshot.packageSha256 },
      });
      return { examId: existing.id, replaced: true };
    });
  }

  /** zip을 임시 폴더에 풀어 검증한 뒤 exams/<slug>로 옮기고 등록한다 */
  async importZip(bytes: Uint8Array, adminId: string): Promise<{ examId: string; slug: string }> {
    if (bytes.byteLength > this.uploadMaxBytes) throw appErrors.payloadTooLarge('업로드 한도를 넘는 파일입니다');
    const { files } = extractPackageZip(bytes, this.uploadMaxBytes);
    const slug = this.readSlug(files.get('exam.json'));
    const target = path.join(this.examsDir, slug);
    if (await this.exists(target)) {
      throw appErrors.conflict('package_dir_exists', `서버에 exams/${slug} 폴더가 이미 있습니다. slug를 바꾸거나 폴더에서 다시 등록하십시오`);
    }

    const stagingRoot = path.join(this.examsDir, UPLOAD_STAGING_DIR, randomUUID());
    const stagingDir = path.join(stagingRoot, slug);
    try {
      for (const [relative, data] of files) {
        const destination = path.join(stagingDir, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, data);
      }
      const result = await loadExamPackage(stagingDir);
      if (!result.ok) throw appErrors.unprocessable('invalid_package', '시험 패키지 검증에 실패했습니다', result.issues);
      await rename(stagingDir, target);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    const { examId } = await this.importDirectory(slug, adminId);
    return { examId, slug };
  }

  private readSlug(examJson: Uint8Array | undefined): string {
    if (examJson === undefined) throw appErrors.unprocessable('invalid_package_layout', 'exam.json이 없습니다');
    let slug: unknown;
    try {
      slug = (JSON.parse(Buffer.from(examJson).toString('utf8').replace(/^﻿/u, '')) as { slug?: unknown }).slug;
    } catch (error) {
      throw appErrors.unprocessable('invalid_package', `exam.json JSON 형식 오류: ${(error as Error).message}`);
    }
    if (typeof slug !== 'string' || !KEY_PATTERN.test(slug)) {
      throw appErrors.unprocessable('invalid_package', 'exam.json의 slug가 없거나 형식이 올바르지 않습니다');
    }
    return slug;
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }
}
