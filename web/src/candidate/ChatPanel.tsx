import type { CandidateCaseView, CandidateMaterialView, ChatMessageView, ConversationSummary } from '@ai-measurement/shared';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { candidateApi } from '../api/candidate-client';
import { ApiError, errorMessage } from '../api/http';
import { formatClock, formatNumber } from '../ui/format';
import { Markdown } from '../ui/Markdown';
import { MaterialSheet, type PendingAttachment } from './MaterialSheet';
import { randomUuid } from './random-id';
import { useConversation } from './use-conversation';

interface ChatPanelProps {
  caseView: CandidateCaseView;
  conversations: ConversationSummary[];
  activeSubquestionKey: string | null;
  onTokenBalance: (balance: number) => void;
  onConversationsChanged: () => Promise<void>;
  onSessionEnded: () => void;
}

function MessageItem({ message }: { message: ChatMessageView }): ReactElement {
  if (message.role === 'user') {
    return (
      <li className="chat-msg chat-user">
        {message.attachments.length > 0 && (
          <ul className="chip-list">
            {message.attachments.map((a) => (
              <li key={a.id} className="chip">
                {a.materialTitle} {a.selection.kind === 'csv' ? `CSV ${a.selection.columns.length}열 ${a.selection.rowCount}행` : `PDF ${a.selection.pageFrom}~${a.selection.pageTo}쪽`}
              </li>
            ))}
          </ul>
        )}
        {message.text.length > 0 && <p className="prewrap">{message.text}</p>}
        <p className="chat-meta small muted">
          <span className="num">{formatClock(message.createdAt)}</span>
          {message.subquestionKey !== null && <span>하위문항 {message.subquestionKey}</span>}
          {message.chargedTokens !== null && <span className="num">토큰 {formatNumber(message.chargedTokens)} 차감</span>}
        </p>
      </li>
    );
  }
  if (message.status === 'error') {
    return (
      <li className="chat-msg chat-assistant">
        <p className="alert">{message.errorMessage}</p>
      </li>
    );
  }
  return (
    <li className="chat-msg chat-assistant">
      <Markdown text={message.text} />
      {message.stopReason === 'max_tokens' && <p className="small alert alert-caution">응답이 길이 한도에서 끊겼습니다.</p>}
      {message.stopReason === 'refusal' && <p className="small alert alert-caution">AI가 이 요청에 답하지 않았습니다.</p>}
    </li>
  );
}

/** 오른쪽 칸: 현재 Case의 AI 대화(PRD 2장 Claude 연동, 6장 토큰 제한) */
export function ChatPanel(props: ChatPanelProps): ReactElement {
  const { caseView, conversations } = props;
  const active = conversations.find((c) => c.status === 'active') ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(active?.id ?? null);
  const selected = conversations.find((c) => c.id === selectedId) ?? active;
  const conversation = useConversation(selected?.id ?? null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [picking, setPicking] = useState<CandidateMaterialView | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ message: string; suggestNewConversation: boolean } | null>(null);
  const logEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (active !== null && selectedId === null) setSelectedId(active.id);
  }, [active, selectedId]);
  // 중괄호 필수: 최신 브라우저의 scrollIntoView는 Promise를 돌려주는데, 그 값이 effect 정리 함수 자리로 가면 React가 오류를 낸다
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [conversation.messages.length, conversation.streamingText]);

  const readOnly = selected === null || selected.status !== 'active';
  const busy = sending || conversation.streamingText !== null;

  const send = async () => {
    if (selected === null) return;
    setSending(true);
    setProblem(null);
    try {
      const result = await candidateApi.sendMessage(selected.id, {
        clientMessageId: randomUuid(),
        subquestionKey: props.activeSubquestionKey,
        text,
        attachments: attachments.map((a) => a.spec),
      });
      conversation.appendMessage(result.userMessage);
      props.onTokenBalance(result.tokenBalance);
      setText('');
      setAttachments([]);
      conversation.followStream();
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) props.onSessionEnded();
      else setProblem({ message: errorMessage(error), suggestNewConversation: error instanceof ApiError && error.code === 'context_limit_exceeded' });
    } finally {
      setSending(false);
    }
  };

  const startNewConversation = async () => {
    if (!window.confirm('새 대화를 시작하면 지금 대화는 읽기 전용이 되고, AI는 이전 대화 내용을 기억하지 않습니다. 시작하시겠습니까?')) return;
    try {
      const created = await candidateApi.newConversation(caseView.key);
      await props.onConversationsChanged();
      setSelectedId(created.id);
      setProblem(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) props.onSessionEnded();
      else setProblem({ message: errorMessage(error), suggestNewConversation: false });
    }
  };

  return (
    <div className="chat">
      <header className="chat-header">
        <h2 className="chat-title">AI 대화</h2>
        {conversations.length > 1 && (
          <select className="select select-compact" aria-label="대화 선택" value={selected?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                대화 {c.seq} {c.status === 'active' ? '(진행 중)' : '(읽기 전용)'}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => void startNewConversation()} disabled={busy}>
          새 대화
        </button>
      </header>
      <ol className="chat-log" aria-live="polite">
        {conversation.messages.length === 0 && conversation.streamingText === null && (
          <li className="chat-empty muted small">이 Case에서 AI에 보낸 내용과 답변이 여기에 쌓입니다. 보낸 내용만큼 토큰이 차감되고 복구되지 않습니다.</li>
        )}
        {conversation.messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
        {conversation.streamingText !== null && (
          <li className="chat-msg chat-assistant is-streaming">
            {conversation.streamingText.length > 0 ? <Markdown text={conversation.streamingText} /> : <p className="muted small">답변을 기다리는 중</p>}
          </li>
        )}
        <li ref={logEnd} aria-hidden="true" />
      </ol>
      {(problem !== null || conversation.failure !== null) && (
        <div className="alert chat-problem" role="alert">
          {problem?.message ?? conversation.failure}
          {problem?.suggestNewConversation === true && (
            <button type="button" className="btn" onClick={() => void startNewConversation()}>
              새 대화 시작
            </button>
          )}
        </div>
      )}
      {readOnly ? (
        <p className="chat-readonly small muted">읽기 전용 대화입니다. 진행 중인 대화를 골라 이어가십시오.</p>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {attachments.length > 0 && (
            <ul className="chip-list">
              {attachments.map((a, index) => (
                <li key={`${a.label}-${index}`} className="chip">
                  {a.label}
                  <button type="button" className="chip-remove" aria-label={`${a.label} 첨부 빼기`} onClick={() => setAttachments((list) => list.filter((_, i) => i !== index))}>
                    빼기
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="visually-hidden" htmlFor="composer-text">
            AI에게 보낼 내용
          </label>
          <textarea id="composer-text" className="textarea composer-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="AI에게 보낼 내용" />
          <div className="composer-actions">
            <div className="attach-menu">
              {caseView.materials.map((m) => (
                <button key={m.key} type="button" className="btn btn-quiet" onClick={() => setPicking(m)} disabled={busy}>
                  {m.title} 첨부
                </button>
              ))}
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || (text.trim().length === 0 && attachments.length === 0)}>
              {sending ? '보내는 중' : '보내기'}
            </button>
          </div>
        </form>
      )}
      {picking !== null && (
        <MaterialSheet
          caseKey={caseView.key}
          material={picking}
          mode="attach"
          onClose={() => setPicking(null)}
          onAttach={(attachment) => {
            setAttachments((list) => [...list, attachment]);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
