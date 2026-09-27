import type { CandidateStateResponse } from '@ai-measurement/shared';
import { useState, type FormEvent, type ReactElement } from 'react';
import { candidateApi } from '../api/candidate-client';
import { errorMessage } from '../api/http';
import { formatDateTime, formatNumber } from '../ui/format';

/** 응시번호 + PIN 로그인(결정 D8) */
export function LoginPage({ onLoggedIn }: { onLoggedIn: () => Promise<void> }): ReactElement {
  const [candidateNo, setCandidateNo] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await candidateApi.login(candidateNo.trim(), pin.trim());
      await onLoggedIn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="entry">
      <form className="entry-card" onSubmit={(e) => void submit(e)}>
        <h1 className="entry-title">AI 실무역량 평가</h1>
        <p className="muted">감독관에게 받은 응시번호와 PIN을 입력하십시오.</p>
        <label className="field">
          <span>응시번호</span>
          <input className="input" autoComplete="username" value={candidateNo} onChange={(e) => setCandidateNo(e.target.value)} required />
        </label>
        <label className="field">
          <span>PIN</span>
          <input className="input" type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} required />
        </label>
        {error !== null && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary entry-submit" type="submit" disabled={busy}>
          {busy ? '확인 중' : '로그인'}
        </button>
      </form>
    </main>
  );
}

/** 시작 전 화면: 안내문과 서약, 시험 시작 */
export function LobbyPage({ state, onStarted, onLogout }: { state: CandidateStateResponse; onStarted: (s: CandidateStateResponse) => void; onLogout: () => void }): ReactElement {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = state.exam.status === 'open';
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      onStarted(await candidateApi.start());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="entry">
      <section className="entry-card entry-wide">
        <p className="muted num">응시번호 {state.candidateNo}</p>
        <h1 className="entry-title">{state.exam.title}</h1>
        <dl className="facts">
          <div>
            <dt>시험 시간</dt>
            <dd className="num">{state.exam.durationMinutes}분</dd>
          </div>
          <div>
            <dt>과제</dt>
            <dd className="num">Case {state.exam.caseCount}개</dd>
          </div>
          <div>
            <dt>AI 입력 토큰</dt>
            <dd className="num">{formatNumber(state.exam.tokenBudget)}</dd>
          </div>
        </dl>
        <div className="alert alert-caution prewrap">{state.exam.candidateNotice}</div>
        <label className="pledge">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          안내를 읽었으며, 시험 중 이 화면의 AI 외에 다른 AI 서비스를 쓰지 않겠습니다.
        </label>
        {!open && <p className="alert">아직 시험이 열리지 않았습니다. 감독관 안내를 기다리십시오.</p>}
        {error !== null && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div className="entry-actions">
          <button type="button" className="btn btn-quiet" onClick={onLogout}>
            로그아웃
          </button>
          <button type="button" className="btn btn-primary" disabled={!agreed || !open || busy} onClick={() => void start()}>
            시험 시작
          </button>
        </div>
      </section>
    </main>
  );
}

/** 종료 화면 */
export function EndedPage({ state }: { state: CandidateStateResponse }): ReactElement {
  const session = state.session;
  return (
    <main className="entry">
      <section className="entry-card">
        <h1 className="entry-title">시험이 끝났습니다</h1>
        <p>{session?.status === 'expired' ? '시험 시간이 끝나 마지막으로 저장한 답안이 최종 제출되었습니다.' : '제출이 완료되었습니다.'}</p>
        {session?.endedAt != null && <p className="muted small">종료 시각 {formatDateTime(session.endedAt)}</p>}
        <p className="muted small">결과는 채점 후 시험 운영자가 안내합니다. 이 창을 닫아도 됩니다.</p>
      </section>
    </main>
  );
}
