import type { CandidateStateResponse } from '@ai-measurement/shared';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { candidateApi } from '../api/candidate-client';
import { ApiError, errorMessage } from '../api/http';
import { EndedPage, LobbyPage, LoginPage } from './EntryPages';
import { Workspace } from './Workspace';
import '../styles/candidate.css';

type Phase = { kind: 'loading' } | { kind: 'login' } | { kind: 'ready'; state: CandidateStateResponse } | { kind: 'failed'; message: string };

/** 응시자 화면의 진입점. 서버 상태로 로그인·시작 전·응시 중·종료 화면을 고른다 */
export function CandidateApp(): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setPhase({ kind: 'ready', state: await candidateApi.state() });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setPhase({ kind: 'login' });
      else setPhase({ kind: 'failed', message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = async () => {
    await candidateApi.logout();
    setPhase({ kind: 'login' });
  };

  switch (phase.kind) {
    case 'loading':
      return <main className="entry muted">불러오는 중</main>;
    case 'failed':
      return (
        <main className="entry">
          <p className="alert" role="alert">
            {phase.message}{' '}
            <button type="button" className="btn" onClick={() => void refresh()}>
              다시 시도
            </button>
          </p>
        </main>
      );
    case 'login':
      return <LoginPage onLoggedIn={refresh} />;
    case 'ready': {
      const { state } = phase;
      if (state.session === null) return <LobbyPage state={state} onStarted={(s) => setPhase({ kind: 'ready', state: s })} onLogout={() => void logout()} />;
      if (state.session.status !== 'active') return <EndedPage state={state} />;
      return <Workspace state={state} refresh={refresh} onState={(s) => setPhase({ kind: 'ready', state: s })} />;
    }
  }
}
