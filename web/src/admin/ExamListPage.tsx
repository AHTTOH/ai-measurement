import type { ExamListItem, ExamPackageListItem } from '@ai-measurement/shared';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { adminApi } from '../api/admin-client';
import { ApiError, errorMessage } from '../api/http';
import { formatDateTime } from '../ui/format';

const STATUS_LABELS: Readonly<Record<ExamListItem['status'], string>> = { draft: '초안', open: '진행', closed: '종료' };

function IssueList({ error }: { error: unknown }): ReactElement {
  const details = error instanceof ApiError && Array.isArray(error.details) ? (error.details as Array<{ file: string; path: string; message: string }>) : [];
  return (
    <div className="alert" role="alert">
      <p>{errorMessage(error)}</p>
      {details.length > 0 && (
        <ul className="issue-list">
          {details.map((d, i) => (
            <li key={i}>
              <code>
                {d.file} {d.path}
              </code>{' '}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 시험 목록과 시험 패키지 등록(결정 D5) */
export function ExamListPage(): ReactElement {
  const [exams, setExams] = useState<ExamListItem[] | null>(null);
  const [packages, setPackages] = useState<ExamPackageListItem[]>([]);
  const [problem, setProblem] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setExams(await adminApi.exams());
      setPackages(await adminApi.packages());
    } catch (e) {
      setProblem(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<string>) => {
    setProblem(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (e) {
      setProblem(e);
    }
  };

  return (
    <main className="admin-page">
      <h1 className="admin-title">시험</h1>
      {problem !== null && <IssueList error={problem} />}
      {notice !== null && <p className="alert alert-caution">{notice}</p>}
      <table className="admin-table">
        <thead>
          <tr>
            <th>시험</th>
            <th>상태</th>
            <th className="num">응시자</th>
            <th className="num">진행 중</th>
            <th className="num">제출</th>
            <th className="num">시간 종료</th>
            <th>등록</th>
          </tr>
        </thead>
        <tbody>
          {exams?.map((exam) => (
            <tr key={exam.id}>
              <td>
                <Link to={`/admin/exams/${exam.id}`}>{exam.title}</Link>
                <div className="muted small">{exam.slug}</div>
              </td>
              <td>
                <span className={`status status-${exam.status}`}>{STATUS_LABELS[exam.status]}</span>
              </td>
              <td className="num">{exam.candidateCount}</td>
              <td className="num">{exam.sessionCounts.active}</td>
              <td className="num">{exam.sessionCounts.submitted}</td>
              <td className="num">{exam.sessionCounts.expired}</td>
              <td className="small">{formatDateTime(exam.importedAt)}</td>
            </tr>
          ))}
          {exams?.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                등록한 시험이 없습니다. 아래에서 시험 패키지를 등록하십시오.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="admin-section">
        <h2 className="admin-subtitle">시험 패키지 등록</h2>
        <p className="muted small">서버의 exams 폴더에 있는 패키지를 검증해 등록하거나, zip 파일을 올립니다. 등록한 시험이 초안이고 응시 기록이 없으면 다시 등록해 내용을 바꿀 수 있습니다.</p>
        <table className="admin-table">
          <thead>
            <tr>
              <th>패키지</th>
              <th>검증</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.slug}>
                <td>
                  {p.title ?? p.slug}
                  <div className="muted small">{p.slug}</div>
                </td>
                <td>{p.ok ? <span className="status status-open">통과</span> : <span className="status status-danger">문제 {p.issues.length}건</span>}</td>
                <td>
                  <button type="button" className="btn" disabled={!p.ok} onClick={() => void run(async () => {
                    const r = await adminApi.importDirectory(p.slug);
                    return r.replaced ? `${p.slug}의 초안을 새 내용으로 바꿨습니다` : `${p.slug}를 등록했습니다`;
                  })}>
                    {p.importedExamId !== null ? '다시 등록' : '등록'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <label className="field admin-upload">
          <span>zip 파일 올리기</span>
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file !== undefined) void run(async () => `${(await adminApi.importZip(file)).slug}를 등록했습니다`);
            }}
          />
        </label>
      </section>
    </main>
  );
}
