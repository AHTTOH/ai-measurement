import { AXES, AXIS_LABELS, type SessionDetailResponse } from '@ai-measurement/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { adminApi } from '../api/admin-client';
import { errorMessage } from '../api/http';
import { formatDateTime, formatElapsed, formatNumber } from '../ui/format';
import { Markdown } from '../ui/Markdown';
import { ScoreSummary } from './ScoreViews';

type Tab = 'grades' | 'conversations' | 'answers' | 'ledger' | 'timeline';
const TABS: ReadonlyArray<[Tab, string]> = [
  ['grades', '채점 근거'],
  ['conversations', '대화'],
  ['answers', '답안 이력'],
  ['ledger', '토큰 원장'],
  ['timeline', '시간 기록'],
];
const ANSWER_SOURCE: Readonly<Record<string, string>> = { candidate_save: '자동저장', candidate_submit: '제출', auto_final_on_end: '종료 시 자동 최종' };

function GradesTab({ detail }: { detail: SessionDetailResponse }): ReactElement {
  if (detail.gradeItems.length === 0) return <p className="muted">아직 채점하지 않았습니다.</p>;
  return (
    <>
      {detail.cases.map(({ key: caseKey, title }) => (
        <section key={caseKey} className="admin-section">
          <h3 className="admin-subtitle">{title}</h3>
          {AXES.map((axis) => {
            const items = detail.gradeItems.filter((g) => g.caseKey === caseKey && g.axis === axis);
            if (items.length === 0) return null;
            return (
              <table key={axis} className="admin-table">
                <caption>{AXIS_LABELS[axis]}</caption>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.itemId}>
                      <td className="num strong">
                        {item.earned === null ? '미채점' : formatNumber(item.earned)} / {item.points}
                      </td>
                      <td>
                        {item.description}
                        <div className="muted small">
                          {item.itemId} {item.grader === 'llm-mock' ? '모의 LLM' : item.grader === 'llm' ? 'LLM' : '규칙'}
                        </div>
                        {typeof item.detail['rationale'] === 'string' && <p className="small">{item.detail['rationale']}</p>}
                        {typeof item.detail['error'] === 'string' && <p className="small text-danger">{item.detail['error']}</p>}
                        <details className="small">
                          <summary>판정 근거 자료</summary>
                          <pre className="detail-json">{JSON.stringify(item.detail, null, 2)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })}
        </section>
      ))}
    </>
  );
}

function ConversationsTab({ detail }: { detail: SessionDetailResponse }): ReactElement {
  return (
    <>
      {detail.conversations.map((c) => (
        <section key={c.id} className="admin-section">
          <h3 className="admin-subtitle">
            {detail.cases.find((x) => x.key === c.caseKey)?.title ?? `시험 정의에 없는 Case(${c.caseKey})`} 대화 {c.seq}{' '}
            <span className="muted small">{c.status === 'active' ? '진행 중' : '닫힘'}</span>
          </h3>
          {c.messages.length === 0 && <p className="muted small">메시지 없음</p>}
          <ol className="transcript">
            {c.messages.map((m) => (
              <li key={m.id} className={`transcript-${m.role}`}>
                <p className="small muted">
                  <span className="num">{formatElapsed(detail.session.startedAt, m.createdAt)}</span> {m.role === 'user' ? '응시자' : 'AI'}
                  {m.subquestionKey !== null && ` 하위문항 ${m.subquestionKey}`}
                  {m.chargedTokens !== null && ` 차감 ${formatNumber(m.chargedTokens)}`}
                  {m.contextTokens !== null && ` 컨텍스트 ${formatNumber(m.contextTokens)}`}
                  {m.usage !== null && ` 입력 ${formatNumber(m.usage.input_tokens)} 캐시 읽기 ${formatNumber(m.usage.cache_read_input_tokens ?? 0)} 출력 ${formatNumber(m.usage.output_tokens)}`}
                </p>
                {m.patternHits.length > 0 && <p className="small text-danger">개인정보 패턴: {m.patternHits.map((h) => `${h.patternId} ${h.count}건`).join(', ')}</p>}
                {m.attachments.map((a) => (
                  <p key={a.id} className="chip">
                    {a.materialTitle} {a.selection.kind === 'csv' ? `CSV [${a.selection.columns.join(', ')}] ${a.selection.rowCount}행` : `PDF ${a.selection.pageFrom}~${a.selection.pageTo}쪽`}
                  </p>
                ))}
                {m.status === 'error' ? <p className="alert small">{m.errorMessage}</p> : m.role === 'assistant' ? <Markdown text={m.text} /> : <p className="prewrap">{m.text}</p>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}

function AnswersTab({ detail }: { detail: SessionDetailResponse }): ReactElement {
  const keys = [...new Set(detail.answers.map((a) => a.subquestionKey))];
  if (keys.length === 0) return <p className="muted">답안이 없습니다.</p>;
  return (
    <>
      {keys.map((key) => (
        <section key={key} className="admin-section">
          <h3 className="admin-subtitle">{key}</h3>
          <ol className="versions">
            {detail.answers
              .filter((a) => a.subquestionKey === key)
              .map((a) => (
                <li key={a.version}>
                  <p className="small muted">
                    v{a.version} <span className="num">{formatElapsed(detail.session.startedAt, a.savedAt)}</span> {ANSWER_SOURCE[a.source]} {a.isFinal ? '(최종본)' : ''}
                  </p>
                  <p className="prewrap">{a.content.kind === 'text' ? a.content.text : `선택: ${a.content.selected.join(', ')}`}</p>
                </li>
              ))}
          </ol>
        </section>
      ))}
    </>
  );
}

function LedgerTab({ detail, onRefund }: { detail: SessionDetailResponse; onRefund: (messageId: string) => void }): ReactElement {
  const refunded = new Set(detail.ledger.filter((l) => l.reason === 'refund').map((l) => l.messageId));
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>시각</th>
          <th>사유</th>
          <th className="num">변동</th>
          <th className="num">잔액</th>
          <th>메모</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {detail.ledger.map((entry) => (
          <tr key={entry.id}>
            <td className="num small">{formatElapsed(detail.session.startedAt, entry.createdAt)}</td>
            <td>{entry.reason === 'initial' ? '시작' : entry.reason === 'message' ? '전송' : '환불'}</td>
            <td className="num">{entry.delta > 0 ? `+${formatNumber(entry.delta)}` : formatNumber(entry.delta)}</td>
            <td className="num">{formatNumber(entry.balanceAfter)}</td>
            <td className="small">{entry.note}</td>
            <td>
              {entry.reason === 'message' && entry.messageId !== null && !refunded.has(entry.messageId) && (
                <button type="button" className="btn btn-quiet" onClick={() => onRefund(entry.messageId as string)}>
                  환불
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TimelineTab({ detail }: { detail: SessionDetailResponse }): ReactElement {
  return (
    <ol className="timeline">
      {detail.timeline.map((event, index) => (
        <li key={index}>
          <span className="num small">{formatElapsed(detail.session.startedAt, event.at)}</span> <strong>{event.kind}</strong>
          {event.subquestionKey !== null && ` ${event.subquestionKey}`}
          {Object.keys(event.payload).length > 0 && <code className="small muted"> {JSON.stringify(event.payload)}</code>}
        </li>
      ))}
    </ol>
  );
}

/** 응시 상세: 한 사람이 어떻게 결과에 도달했는지(PRD 11장) */
export function SessionDetailPage(): ReactElement {
  const { sessionId } = useParams();
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [tab, setTab] = useState<Tab>('grades');
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(10);
  const [reason, setReason] = useState('');
  const load = useCallback(async () => {
    if (sessionId === undefined) return;
    try {
      setDetail(await adminApi.session(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [sessionId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (detail === null) return error !== null ? <p className="alert admin-page">{error}</p> : <p className="muted admin-page">불러오는 중</p>;

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const extend = (event: FormEvent) => {
    event.preventDefault();
    void act(() => adminApi.extend(detail.session.id, minutes, reason));
  };
  const refund = (messageId: string) => {
    const note = window.prompt('환불 사유를 적으십시오(예: API 장애로 응답 없음)');
    if (note !== null && note.trim() !== '') void act(() => adminApi.refund(detail.session.id, messageId, note.trim()));
  };

  return (
    <main className="admin-page">
      <p className="small">
        <Link to={`/admin/exams/${detail.examId}`}>{detail.examTitle}</Link>
      </p>
      <div className="admin-heading">
        <h1 className="admin-title num">{detail.candidateNo}</h1>
        <a className="btn" href={adminApi.sessionExportUrl(detail.session.id)}>
          전체 기록 JSON
        </a>
      </div>
      <p className="small muted">
        시작 {formatDateTime(detail.session.startedAt)}, 만료 {formatDateTime(detail.session.expiresAt)}
        {detail.session.endedAt !== null && `, 종료 ${formatDateTime(detail.session.endedAt)}`}, 토큰 {formatNumber(detail.session.tokenBudget - detail.session.tokenBalance)} 사용
      </p>
      {error !== null && <p className="alert">{error}</p>}
      {detail.session.status === 'active' && (
        <form className="inline-form" onSubmit={extend}>
          <label className="field">
            <span>시간 연장(분)</span>
            <input className="input input-narrow" type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </label>
          <label className="field field-grow">
            <span>사유</span>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} required />
          </label>
          <button type="submit" className="btn">
            연장
          </button>
        </form>
      )}
      {detail.latestScore !== null && <ScoreSummary score={detail.latestScore} />}
      {detail.violations.length > 0 && (
        <section className="admin-section">
          <h2 className="admin-subtitle text-danger">중대 보안 위반</h2>
          <ul className="violations">
            {detail.violations.map((v) => (
              <li key={v.id}>
                {v.label} <strong className="num">{formatNumber(v.count)}</strong>건 AI 전송 <span className="muted small">({v.source}, {v.tag})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="tab" onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'grades' && <GradesTab detail={detail} />}
        {tab === 'conversations' && <ConversationsTab detail={detail} />}
        {tab === 'answers' && <AnswersTab detail={detail} />}
        {tab === 'ledger' && <LedgerTab detail={detail} onRefund={refund} />}
        {tab === 'timeline' && <TimelineTab detail={detail} />}
      </div>
    </main>
  );
}
