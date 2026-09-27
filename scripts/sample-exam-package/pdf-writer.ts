import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * 한글 본문 PDF를 만드는 최소 작성기. 샘플 시험 자료용이다.
 * 폰트는 설치된 Pretendard(OFL)를 서브셋으로 임베드한다.
 */

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const BODY_SIZE = 11;
const HEADING_SIZE = 16;
const LINE_GAP = 6;
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

export type PdfBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'label'; text: string };

export interface PdfFonts {
  regularPath: string;
  boldPath: string;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraphLine of text.split('\n')) {
    let current = '';
    for (const char of paragraphLine) {
      const candidate = current + char;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current.length > 0) {
        lines.push(current);
        current = char.trimStart();
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

class PageCursor {
  private y = PAGE_HEIGHT - MARGIN;
  constructor(private readonly page: PDFPage) {}

  write(lines: string[], font: PDFFont, size: number, color = rgb(0.1, 0.12, 0.16)): void {
    for (const line of lines) {
      this.y -= size;
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font, color });
      this.y -= LINE_GAP;
    }
    this.y -= LINE_GAP;
  }
}

/** 페이지마다 블록 목록을 받아 PDF 바이트를 만든다. 메타데이터 날짜를 고정해 매번 같은 결과가 나오게 한다. */
export async function buildPdf(title: string, pages: PdfBlock[][], fonts: PdfFonts): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(await readFile(fonts.regularPath), { subset: true });
  const bold = await doc.embedFont(await readFile(fonts.boldPath), { subset: true });
  doc.setTitle(title);
  doc.setProducer('ai-measurement sample exam builder');
  doc.setCreator('ai-measurement sample exam builder');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);

  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  for (const blocks of pages) {
    const cursor = new PageCursor(doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
    for (const block of blocks) {
      if (block.kind === 'heading') {
        cursor.write(wrapText(block.text, bold, HEADING_SIZE, maxWidth), bold, HEADING_SIZE);
      } else if (block.kind === 'label') {
        cursor.write(wrapText(block.text, bold, BODY_SIZE, maxWidth), bold, BODY_SIZE, rgb(0.62, 0.1, 0.12));
      } else {
        cursor.write(wrapText(block.text, regular, BODY_SIZE, maxWidth), regular, BODY_SIZE);
      }
    }
  }
  return doc.save({ useObjectStreams: false });
}
