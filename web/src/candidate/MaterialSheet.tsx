import type { AttachmentSpec, CandidateMaterialView, MaterialPreviewResponse } from '@ai-measurement/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { candidateApi } from '../api/candidate-client';
import { errorMessage } from '../api/http';
import { formatNumber } from '../ui/format';

export interface PendingAttachment {
  spec: AttachmentSpec;
  label: string;
}

interface MaterialSheetProps {
  caseKey: string;
  material: CandidateMaterialView;
  mode: 'view' | 'attach';
  onAttach: (attachment: PendingAttachment) => void;
  onClose: () => void;
}

function CsvPicker({ preview, attach, onAttach }: { preview: Extract<MaterialPreviewResponse, { kind: 'csv' }>; attach: boolean; onAttach: (columns: string[], rows: number[]) => void }): ReactElement {
  const [columns, setColumns] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Set<number>>(new Set());
  const allRows = preview.rows.length > 0 && rows.size === preview.rows.length;
  const allColumns = preview.headers.length > 0 && columns.size === preview.headers.length;
  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };
  return (
    <>
      {attach && (
        <div className="sheet-toolbar">
          <span className="small">
            컬럼 <strong className="num">{columns.size}</strong>개, 행 <strong className="num">{formatNumber(rows.size)}</strong>개 선택
          </span>
          <button type="button" className="btn" onClick={() => setColumns(allColumns ? new Set() : new Set(preview.headers))}>
            {allColumns ? '열 선택 모두 해제' : '열 모두 선택'}
          </button>
          <button type="button" className="btn" onClick={() => setRows(allRows ? new Set() : new Set(preview.rows.map((_, i) => i)))}>
            {allRows ? '행 선택 모두 해제' : '행 모두 선택'}
          </button>
          <button type="button" className="btn btn-primary" disabled={columns.size === 0 || rows.size === 0} onClick={() => onAttach(preview.headers.filter((h) => columns.has(h)), [...rows].sort((a, b) => a - b))}>
            이 선택으로 첨부
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {attach && <th scope="col" className="select-cell"><span className="visually-hidden">행 선택</span></th>}
              <th scope="col" className="num">#</th>
              {preview.headers.map((header) => (
                <th key={header} scope="col" className={columns.has(header) ? 'is-picked' : undefined}>
                  {attach ? (
                    <label className="column-pick">
                      <input type="checkbox" checked={columns.has(header)} onChange={() => setColumns((s) => toggle(s, header))} />
                      {header}
                    </label>
                  ) : (
                    header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index} className={rows.has(index) ? 'is-selected' : undefined}>
                {attach && (
                  <td className="select-cell">
                    <input type="checkbox" aria-label={`${index + 1}행 선택`} checked={rows.has(index)} onChange={() => setRows((s) => toggle(s, index))} />
                  </td>
                )}
                <td className="num muted">{index + 1}</td>
                {row.map((cell, ci) => (
                  <td key={ci} className={columns.has(preview.headers[ci] ?? '') ? 'is-picked' : undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PdfPicker({ fileUrl, pageCount, attach, onAttach }: { fileUrl: string; pageCount: number; attach: boolean; onAttach: (from: number, to: number) => void }): ReactElement {
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(pageCount);
  const valid = from >= 1 && to <= pageCount && from <= to;
  return (
    <>
      {attach && (
        <div className="sheet-toolbar">
          <label className="field field-inline">
            <span>시작 쪽</span>
            <input className="input input-narrow" type="number" min={1} max={pageCount} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
          </label>
          <label className="field field-inline">
            <span>끝 쪽</span>
            <input className="input input-narrow" type="number" min={1} max={pageCount} value={to} onChange={(e) => setTo(Number(e.target.value))} />
          </label>
          <span className="small muted">전체 {pageCount}쪽</span>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={() => onAttach(from, to)}>
            이 범위로 첨부
          </button>
        </div>
      )}
      <iframe className="pdf-frame" src={fileUrl} title="PDF 자료" />
    </>
  );
}

/** 자료 보기·첨부 시트. 첨부할 때 무엇을 보낼지는 응시자가 고른다(정보 판단 평가, 결정 D3) */
export function MaterialSheet({ caseKey, material, mode, onAttach, onClose }: MaterialSheetProps): ReactElement {
  const [preview, setPreview] = useState<MaterialPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const fileUrl = candidateApi.materialFileUrl(caseKey, material.key);

  useEffect(() => {
    closeButton.current?.focus();
    candidateApi.materialPreview(caseKey, material.key).then(setPreview, (e: unknown) => setError(errorMessage(e)));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [caseKey, material.key, onClose]);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <header className="sheet-header">
          <h2 id="sheet-title">
            {material.title} <span className="muted small">{mode === 'attach' ? 'AI에 보낼 범위 고르기' : '자료 보기'}</span>
          </h2>
          <a className="btn btn-quiet" href={fileUrl} download>
            내려받기
          </a>
          <button ref={closeButton} type="button" className="btn" onClick={onClose}>
            닫기
          </button>
        </header>
        {error !== null && <p className="alert">{error}</p>}
        {preview === null && error === null && <p className="muted sheet-loading">불러오는 중</p>}
        {preview?.kind === 'csv' && (
          <CsvPicker
            preview={preview}
            attach={mode === 'attach'}
            onAttach={(columns, rows) =>
              onAttach({ spec: { kind: 'csv', materialKey: material.key, columns, rowIndexes: rows }, label: `${material.title} CSV ${columns.length}열 ${rows.length}행` })
            }
          />
        )}
        {preview?.kind === 'pdf' && (
          <PdfPicker
            fileUrl={fileUrl}
            pageCount={preview.pageCount}
            attach={mode === 'attach'}
            onAttach={(from, to) => onAttach({ spec: { kind: 'pdf', materialKey: material.key, pageFrom: from, pageTo: to }, label: `${material.title} PDF ${from}~${to}쪽` })}
          />
        )}
      </section>
    </div>
  );
}
