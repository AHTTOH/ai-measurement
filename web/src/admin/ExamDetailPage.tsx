import { AXES, AXIS_LABELS, type AiProviderName, type ExamDetailResponse, type GeneratedCandidate } from '@ai-measurement/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { adminApi } from '../api/admin-client';
import { errorMessage } from '../api/http';
import { formatDateTime, formatNumber, formatScore } from '../ui/format';
import { isMockGraded, OutcomeLabel, ScoreBar } from './ScoreViews';

/** 진행 중인 채점 작업이 있을 때 상태를 다시 읽는 간격 */
const JOB_POLL_MS = 5000;

const SESSION_STATUS: Readonly<Record<string, string>> = { not_started: '시작 전', active: '응시 중', submitted: '제출', expired: '시간 종료' };
const JOB_STATUS: Readonly<Record<string, string>> = { queued: '대기', running: '채점 중', waiting_batch: '배치 결과 대기', done: '완료', failed: '실패' };
const PROVIDER_LABELS: Readonly<Record<AiProviderName, string>> = { mock: '모의', anthropic: 'Claude API' };

/** 응시 AI 공급자는 수험생 서버 설정이라 관리자 화면은 메시지에 남은 기록만 보여 준다 */
function describeProviders(providers: AiProviderName[]): string {
  return providers.length === 0 ? '없음(아직 AI 대화 없음)' : providers.map((p) => PROVIDER_LABELS[p]).join(', ');
}

function downloadPins(slug: string, candidates: GeneratedCandidate[]): void {
  const csv = `﻿응시번호,PIN\n${candidates.map((c) => `${c.candidateNo},${c.pin}`).join('\n')}\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slug}-candidates.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function CandidateGenerator({ exam, onDone }: { exam: ExamDetailResponse; onDone: () => Promise<void> }): ReactElement {
  const [prefix, setPrefix] = useState('');
  const [count, setCount] = useState(10);
  const [generated, setGenerated] = useState<GeneratedCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setGenerated(await adminApi.generateCandidates(exam.id, prefix, count));
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section className="admin-section">
      <h2 className="admin-subtitle">응시자 발급</h2>
      <form className="inline-form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>응시번호 접두사</span>
          <input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} pattern="[A-Z0-9]{1,8}" required />
        </label>
        <label className="field">
          <span>인원</span>
          <input className="input input-narrow" type="number" min={1} max={1000} value={count} onChange={(e) => setCount(Number(e.target.value))} required />
        </label>
        <button type="submit" className="btn btn-primary" disabled={exam.status === 'closed'}>
          발급
        </button>
      </form>
      {error !== null && <p className="alert">{error}</p>}
      {generated !== null && (
        <div className="alert alert-caution">
          <p>
            <strong>PIN은 지금 한 번만 볼 수 있습니다.</strong> 서버에는 해시만 저장됩니다. 파일로 내려받아 응시자에게 전달하십시오.
          </p>
          <button type="button" className="btn" onClick={() => downloadPins(exam.slug, generated)}>
            응시번호·PIN CSV 내려받기({generated.length}명)
          </button>
        </div>
      )}
    </section>
  );
}

function GradingControls({ exam, onDone }: { exam: ExamDetailResponse; onDone: () => Promise<void> }): ReactElement {
  const [mode, setMode] = useState<'direct' | 'batch'>('batch');
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      await adminApi.createGradingJob(exam.id, mode);
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <section className="admin-section">
      <h2 className="admin-subtitle">채점</h2>
      {exam.gradingLlmProvider === 'mock' && <p className="alert alert-caution small">채점 LLM이 모의 구현입니다. 기준(criteria) 점수는 실제 평가가 아닙니다.</p>}
      <div className="inline-form">
        <label className="field">
          <span>LLM 채점 방식</span>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'direct' | 'batch')}>
            <option value="batch">배치(비용 50%, 결과까지 최대 24시간)</option>
            <option value="direct">즉시</option>
          </select>
        </label>
        <button type="button" className="btn btn-primary" onClick={() => void run()}>
          채점 실행
        </button>
      </div>
      {error !== null && <p className="alert">{error}</p>}
      {exam.gradingJobs.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>요청</th>
              <th>상태</th>
              <th>방식</th>
              <th>진행</th>
              <th>메모</th>
            </tr>
          </thead>
          <tbody>
            {exam.gradingJobs.map((job) => (
              <tr key={job.id}>
                <td className="small">{formatDateTime(job.createdAt)}</td>
                <td>{JOB_STATUS[job.status]}</td>
                <td className="small">
                  {job.llmMode === 'batch' ? '배치' : '즉시'} {job.llmProvider === 'mock' ? '(모의)' : ''}
                </td>
                <td className="num small">{job.progress === null ? '' : `${job.progress.sessionsGraded}/${job.progress.sessionsTotal}${job.progress.skippedActive > 0 ? `, 응시 중 ${job.progress.skippedActive}명 제외` : ''}`}</td>
                <td className="small">{job.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** 시험 상세: 상태 전환, 응시자 발급, 채점, 결과 표(PRD 8장) */
export function ExamDetailPage(): ReactElement {
  const { examId } = useParams();
  const [exam, setExam] = useState<ExamDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (examId === undefined) return;
    try {
      setExam(await adminApi.exam(examId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [examId]);
  useEffect(() => {
    void load();
  }, [load]);
  const jobsRunning = exam?.gradingJobs.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting_batch') ?? false;
  useEffect(() => {
    if (!jobsRunning) return;
    const timer = setInterval(() => void load(), JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [jobsRunning, load]);

  if (error !== null) return <p className="alert admin-page">{error}</p>;
  if (exam === null) return <p className="muted admin-page">불러오는 중</p>;

  const changeStatus = async (status: 'open' | 'closed') => {
    const message = status === 'open' ? '시험을 열면 응시자가 시작할 수 있고, 패키지를 다시 등록할 수 없습니다. 여시겠습니까?' : '시험을 종료하면 새로 시작할 수 없습니다. 이미 시작한 응시자는 각자의 시간까지 계속합니다. 종료하시겠습니까?';
    if (!window.confirm(message)) return;
    try {
      await adminApi.changeStatus(exam.id, status);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <main className="admin-page">
      <p className="small">
        <Link to="/admin">시험 목록</Link>
      </p>
      <div className="admin-heading">
        <h1 className="admin-title">{exam.title}</h1>
        <span className={`status status-${exam.status}`}>{exam.status === 'draft' ? '초안' : exam.status === 'open' ? '진행' : '종료'}</span>
        {exam.status === 'draft' && (
          <button type="button" className="btn btn-primary" onClick={() => void changeStatus('open')}>
            시험 열기
          </button>
        )}
        {exam.status === 'open' && (
          <button type="button" className="btn btn-danger" onClick={() => void changeStatus('closed')}>
            시험 종료
          </button>
        )}
      </div>
      <p className="muted small">
        {exam.slug} 패키지 해시 <code>{exam.packageSha256.slice(0, 12)}</code> 응시 AI 기록 {describeProviders(exam.aiProvidersUsed)}
      </p>

      <CandidateGenerator exam={exam} onDone={load} />
      <GradingControls exam={exam} onDone={load} />

      <section className="admin-section">
        <div className="admin-heading">
          <h2 className="admin-subtitle">응시 현황과 결과</h2>
          <a className="btn" href={adminApi.scoresCsvUrl(exam.id)}>
            점수 CSV
          </a>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>응시번호</th>
              <th>상태</th>
              <th className="num">사용 토큰</th>
              <th>총점</th>
              {AXES.map((axis) => (
                <th key={axis}>{AXIS_LABELS[axis]}</th>
              ))}
              <th className="num">중대 위반</th>
              <th>판정</th>
            </tr>
          </thead>
          <tbody>
            {exam.sessions.map((s) => (
              <tr key={s.candidateNo}>
                <td>{s.examSessionId !== null ? <Link to={`/admin/sessions/${s.examSessionId}`}>{s.candidateNo}</Link> : s.candidateNo}</td>
                <td>{SESSION_STATUS[s.status]}</td>
                <td className="num">{s.tokenUsed === null ? '' : formatNumber(s.tokenUsed)}</td>
                <td className="num strong">
                  {s.score === null ? '' : formatScore(s.score.total)}
                  {s.score !== null && isMockGraded(s.score) && <span className="mock-flag">모의</span>}
                </td>
                {AXES.map((axis) => (
                  <td key={axis}>{s.score === null ? '' : <ScoreBar value={s.score.axisPercent[axis]} />}</td>
                ))}
                <td className={`num ${s.score !== null && s.score.violationCount > 0 ? 'text-danger strong' : ''}`}>{s.score === null ? '' : s.score.violationCount}</td>
                <td>{s.score === null ? '' : <OutcomeLabel outcome={s.score.outcome} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
