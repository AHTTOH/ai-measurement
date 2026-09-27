import type { AttachmentSelection, MaterialFileSnapshot } from '@ai-measurement/infra';
import type { AttachmentSpec, CsvTable, MaterialPreviewResponse } from '@ai-measurement/shared';
import { CsvSelectionError, parseCsvText, readVerifiedMaterial, renderCsv, selectCsv } from '@ai-measurement/shared/node';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { appErrors } from '../../lib/app-error';
import { sha256Hex } from '../../lib/secrets';
import type { ExamCatalog, ExamRecord } from '../exams/exam-catalog';

export interface RenderedAttachment {
  materialKey: string;
  materialTitle: string;
  selection: AttachmentSelection;
  /** CSV: 보낼 텍스트 그대로 */
  renderedText: string | null;
  /** PDF: 보낼 PDF 바이트, 해시, document 블록 제목 */
  pdf: { bytes: Buffer; sha256: string; documentTitle: string } | null;
}

/** PDF 부분 추출 결과를 매번 같게 만들기 위한 고정 메타데이터 날짜 */
const FIXED_PDF_DATE = new Date('2000-01-01T00:00:00Z');

/**
 * 시험 자료 읽기와 첨부 전송 본문 만들기.
 * 자료 파일은 등록 당시 해시와 대조한 뒤에만 쓴다(결정 D5).
 */
export class MaterialService {
  private readonly bytesCache = new Map<string, Buffer>();
  private readonly csvCache = new Map<string, CsvTable>();
  private readonly pageCountCache = new Map<string, number>();

  constructor(private readonly catalog: ExamCatalog) {}

  private snapshot(exam: ExamRecord, materialKey: string): MaterialFileSnapshot {
    const snapshot = exam.materialFiles[materialKey];
    if (snapshot === undefined) throw new Error(`등록 스냅샷에 자료 '${materialKey}'의 파일 정보가 없습니다`);
    return snapshot;
  }

  async bytes(exam: ExamRecord, materialKey: string): Promise<{ bytes: Buffer; snapshot: MaterialFileSnapshot }> {
    const snapshot = this.snapshot(exam, materialKey);
    const cached = this.bytesCache.get(snapshot.sha256);
    if (cached !== undefined) return { bytes: cached, snapshot };
    const bytes = await readVerifiedMaterial(this.catalog.packageDir(exam), snapshot);
    this.bytesCache.set(snapshot.sha256, bytes);
    return { bytes, snapshot };
  }

  async csvTable(exam: ExamRecord, materialKey: string): Promise<CsvTable> {
    const { bytes, snapshot } = await this.bytes(exam, materialKey);
    const cached = this.csvCache.get(snapshot.sha256);
    if (cached !== undefined) return cached;
    const table = parseCsvText(bytes.toString('utf8'));
    this.csvCache.set(snapshot.sha256, table);
    return table;
  }

  async pdfPageCount(exam: ExamRecord, materialKey: string): Promise<number> {
    const { bytes, snapshot } = await this.bytes(exam, materialKey);
    const cached = this.pageCountCache.get(snapshot.sha256);
    if (cached !== undefined) return cached;
    const count = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
    this.pageCountCache.set(snapshot.sha256, count);
    return count;
  }

  async preview(exam: ExamRecord, caseKey: string, materialKey: string): Promise<MaterialPreviewResponse> {
    const material = this.catalog.findMaterial(exam, caseKey, materialKey);
    if (material.kind === 'csv') {
      const table = await this.csvTable(exam, materialKey);
      return { kind: 'csv', headers: table.headers, rows: table.rows };
    }
    return { kind: 'pdf', pageCount: await this.pdfPageCount(exam, materialKey) };
  }

  async download(exam: ExamRecord, caseKey: string, materialKey: string): Promise<{ bytes: Buffer; fileName: string; contentType: string }> {
    const material = this.catalog.findMaterial(exam, caseKey, materialKey);
    const { bytes } = await this.bytes(exam, materialKey);
    return {
      bytes,
      fileName: path.posix.basename(material.file),
      contentType: material.kind === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
    };
  }

  /** 응시자가 고른 범위로 실제 전송 본문을 만든다(결정 D3) */
  async render(exam: ExamRecord, caseKey: string, spec: AttachmentSpec): Promise<RenderedAttachment> {
    const material = this.catalog.findMaterial(exam, caseKey, spec.materialKey);
    if (material.kind !== spec.kind) throw appErrors.badRequest('attachment_kind_mismatch', `이 자료는 ${material.kind.toUpperCase()}입니다`);
    const fileName = path.posix.basename(material.file);

    if (spec.kind === 'csv') {
      const table = await this.csvTable(exam, spec.materialKey);
      let selected: CsvTable;
      try {
        selected = selectCsv(table, { columns: spec.columns, rowIndexes: spec.rowIndexes });
      } catch (error) {
        if (error instanceof CsvSelectionError) throw appErrors.badRequest('invalid_attachment', error.message);
        throw error;
      }
      const text = `[첨부 자료: ${material.title} (${fileName}), ${selected.rows.length}행 ${selected.headers.length}열]\n${renderCsv(selected)}`;
      return {
        materialKey: spec.materialKey,
        materialTitle: material.title,
        selection: { kind: 'csv', columns: selected.headers, rowIndexes: [...spec.rowIndexes].sort((a, b) => a - b) },
        renderedText: text,
        pdf: null,
      };
    }

    const pageCount = await this.pdfPageCount(exam, spec.materialKey);
    if (spec.pageFrom > spec.pageTo || spec.pageTo > pageCount) {
      throw appErrors.badRequest('invalid_attachment', `페이지 범위가 올바르지 않습니다(1~${pageCount}쪽)`);
    }
    const bytes = await this.pdfPages(exam, spec.materialKey, spec.pageFrom, spec.pageTo, pageCount);
    const rangeLabel = spec.pageFrom === 1 && spec.pageTo === pageCount ? '전체' : `${spec.pageFrom}~${spec.pageTo}쪽`;
    return {
      materialKey: spec.materialKey,
      materialTitle: material.title,
      selection: { kind: 'pdf', pageFrom: spec.pageFrom, pageTo: spec.pageTo },
      renderedText: null,
      pdf: { bytes, sha256: sha256Hex(bytes), documentTitle: `${material.title} (${fileName}, ${rangeLabel})` },
    };
  }

  private async pdfPages(exam: ExamRecord, materialKey: string, from: number, to: number, pageCount: number): Promise<Buffer> {
    const { bytes } = await this.bytes(exam, materialKey);
    if (from === 1 && to === pageCount) return bytes;
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const output = await PDFDocument.create({ updateMetadata: false });
    const indexes = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
    for (const page of await output.copyPages(source, indexes)) output.addPage(page);
    output.setCreationDate(FIXED_PDF_DATE);
    output.setModificationDate(FIXED_PDF_DATE);
    return Buffer.from(await output.save({ useObjectStreams: false }));
  }
}
