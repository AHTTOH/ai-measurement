import type { CandidateAnswerView, CandidateMaterialView, CandidateNoticeView, CandidateStateResponse, ClientEventRequest } from '@ai-measurement/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { candidateApi } from '../api/candidate-client';
import { CASE_TOP_ANCHOR, CaseDocument, subquestionAnchor } from './CaseDocument';
import { ChatPanel } from './ChatPanel';
import { ConsoleBar } from './ConsoleBar';
import { MaterialSheet } from './MaterialSheet';
import { NoticeStrip } from './NoticeStrip';
import { acknowledge, loadAcknowledged } from './notice-acknowledgements';
import { SubquestionNav } from './SubquestionNav';
import { useServerNow } from './use-server-clock';

/** 공지·잔액·세션 상태를 서버와 맞추는 간격 */
const STATE_POLL_MS = 30_000;

interface WorkspaceProps {
  state: CandidateStateResponse;
  refresh: () => Promise<void>;
  onState: (state: CandidateStateResponse) => void;
}

function sendEvent(event: ClientEventRequest, onFailure: () => void): void {
  candidateApi.event(event).catch(onFailure);
}

/** 응시 작업대: 계기판, 공지, 문항 목록, 문항·답안, AI 대화 */
export function Workspace({ state, refresh, onState }: WorkspaceProps): ReactElement {
  const session = state.session;
  if (session === null) throw new Error('시작하지 않은 시험의 작업대는 열 수 없습니다');
  const now = useServerNow(state.serverNow);
  const remainingMs = new Date(session.expiresAt).getTime() - now;
  const [caseKey, setCaseKey] = useState(state.cases[0]?.key ?? '');
  /** 한 페이지 문서에서 지금 보는 문항. 과제 설명 구역이면 null */
  const [reading, setReading] = useState<string | null>(null);
  const [material, setMaterial] = useState<CandidateMaterialView | null>(null);
  const [acknowledged, setAcknowledged] = useState(() => loadAcknowledged(session.id));
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const eventFailed = useCallback(() => setBackgroundError('일부 활동 기록을 서버에 보내지 못했습니다. 네트워크를 확인하십시오'), []);

  const caseView = state.cases.find((c) => c.key === caseKey) ?? state.cases[0];
  if (caseView === undefined) throw new Error('시험에 Case가 없습니다');
  const answers = useMemo(() => new Map(state.answers.map((a) => [a.subquestionKey, a])), [state.answers]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), STATE_POLL_MS);
    const onVisibility = () => sendEvent({ kind: document.hidden ? 'tab_hidden' : 'tab_visible', subquestionKey: null }, eventFailed);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, eventFailed]);

  // 시간이 다 되면 서버가 세션을 끝내도록 상태를 다시 읽는다
  const expiredHandled = useRef(false);
  useEffect(() => {
    if (remainingMs <= 0 && !expiredHandled.current) {
      expiredHandled.current = true;
      void refresh();
    }
  }, [remainingMs, refresh]);

  // 하위문항 진입·이탈 기록(PRD 11장 문항별 시간)
  const currentKey = reading;
  useEffect(() => {
    if (currentKey === null) return;
    sendEvent({ kind: 'subquestion_enter', subquestionKey: currentKey }, eventFailed);
    return () => sendEvent({ kind: 'subquestion_leave', subquestionKey: currentKey }, eventFailed);
  }, [currentKey, eventFailed]);

  const pendingNotices = state.cases.flatMap((c) => c.notices.filter((n) => !acknowledged.has(n.key)).map((n) => ({ ...n, caseTitle: c.title })));

  const onSaved = useCallback(
    (answer: CandidateAnswerView, revealed: CandidateNoticeView[]) => {
      onState({ ...state, answers: [...state.answers.filter((a) => a.subquestionKey !== answer.subquestionKey), answer] });
      if (revealed.length > 0) void refresh();
    },
    [state, onState, refresh],
  );

  const endExam = async () => {
    if (!window.confirm('시험을 끝내면 다시 들어올 수 없고, 마지막으로 저장한 답안이 최종 제출됩니다. 끝내시겠습니까?')) return;
    onState(await candidateApi.submitExam());
  };

  return (
    <div className="workspace">
      <ConsoleBar
        examTitle={state.exam.title}
        candidateNo={state.candidateNo}
        cases={state.cases}
        activeCaseKey={caseView.key}
        onSelectCase={(key) => {
          setCaseKey(key);
          setReading(null);
        }}
        tokenBalance={session.tokenBalance}
        tokenBudget={session.tokenBudget}
        remainingMs={remainingMs}
        aiProvider={state.aiProvider}
        onEndExam={() => void endExam()}
      />
      <NoticeStrip notices={pendingNotices} onAcknowledge={(key) => setAcknowledged(acknowledge(session.id, key))} />
      {backgroundError !== null && (
        <p className="alert workspace-alert" role="alert">
          {backgroundError}{' '}
          <button type="button" className="btn btn-quiet" onClick={() => setBackgroundError(null)}>
            닫기
          </button>
        </p>
      )}
      <div className="workspace-body">
        <aside className="pane pane-nav">
          <SubquestionNav
            caseView={caseView}
            answers={answers}
            reading={reading}
            onJump={(key) => document.getElementById(key === null ? CASE_TOP_ANCHOR : subquestionAnchor(key))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            onOpenMaterial={setMaterial}
          />
        </aside>
        <main className="pane pane-task">
          <CaseDocument
            key={caseView.key}
            caseView={caseView}
            answers={answers}
            candidateNotice={state.exam.candidateNotice}
            onSaved={onSaved}
            onSessionEnded={() => void refresh()}
            onBackgroundError={setBackgroundError}
            onReading={setReading}
          />
        </main>
        <section className="pane pane-ai" aria-label="AI 대화">
          <ChatPanel
            key={caseView.key}
            caseView={caseView}
            conversations={state.conversations.filter((c) => c.caseKey === caseView.key)}
            activeSubquestionKey={reading}
            onTokenBalance={(balance) => onState({ ...state, session: { ...session, tokenBalance: balance } })}
            onConversationsChanged={refresh}
            onSessionEnded={() => void refresh()}
          />
        </section>
      </div>
      {material !== null && <MaterialSheet caseKey={caseView.key} material={material} mode="view" onAttach={() => {}} onClose={() => setMaterial(null)} />}
    </div>
  );
}
