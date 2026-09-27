import type { AnswerContent, CandidateAnswerView, CandidateNoticeView, CandidateSubquestionView } from '@ai-measurement/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { candidateApi } from '../api/candidate-client';
import { ApiError, errorMessage } from '../api/http';
import { formatClock } from '../ui/format';

/** 입력이 멈춘 뒤 자동저장까지 기다리는 시간 */
const AUTOSAVE_DELAY_MS = 1500;

interface AnswerEditorProps {
  subquestion: CandidateSubquestionView;
  saved: CandidateAnswerView | undefined;
  onSaved: (answer: CandidateAnswerView, newlyRevealed: CandidateNoticeView[]) => void;
  onSessionEnded: () => void;
  onBackgroundError: (message: string) => void;
}

type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error'; message: string };

function emptyContent(subquestion: CandidateSubquestionView): AnswerContent {
  if (subquestion.answer.kind === 'text') return { kind: 'text', text: '' };
  return subquestion.answer.note !== undefined ? { kind: 'multi_choice', selected: [], note: '' } : { kind: 'multi_choice', selected: [] };
}

/** 답안 조건 한 줄. 문항 형식에서 만든다 */
export function answerCondition(subquestion: CandidateSubquestionView): string {
  if (subquestion.answer.kind === 'text') return '서술형. 마크다운 표를 쓸 수 있습니다.';
  const note = subquestion.answer.note !== undefined ? ` ${subquestion.answer.note.label} 칸에 근거를 적을 수 있습니다.` : '';
  return `선택형. 해당하는 것을 모두 고르십시오.${note}`;
}

/**
 * 답안 편집기. 입력하면 자동저장하고, 임시 저장(바로 저장)과 최종 제출은 버튼으로 한다(PRD 11장 중간·최종 답안).
 * 한 페이지에 여러 편집기가 놓이므로 입력 칸 이름에 문항 번호를 붙인다.
 */
export function AnswerEditor({ subquestion, saved, onSaved, onSessionEnded, onBackgroundError }: AnswerEditorProps) {
  const [content, setContent] = useState<AnswerContent>(saved?.content ?? emptyContent(subquestion));
  const [status, setStatus] = useState<SaveStatus>(saved !== undefined ? { kind: 'saved', at: saved.savedAt } : { kind: 'idle' });
  const dirty = useRef(false);
  const latest = useRef(content);
  latest.current = content;
  // 부모가 다시 그려져도 저장 함수가 바뀌지 않도록 콜백은 ref로 들고 있는다
  const callbacks = useRef({ onSaved, onSessionEnded, onBackgroundError });
  callbacks.current = { onSaved, onSessionEnded, onBackgroundError };

  const persist = useCallback(
    async (value: AnswerContent, submit: boolean, background = false) => {
      dirty.current = false;
      if (!background) setStatus({ kind: 'saving' });
      try {
        const result = submit ? await candidateApi.submitAnswer(subquestion.key, value) : await candidateApi.saveAnswer(subquestion.key, value);
        callbacks.current.onSaved(result.answer, result.newlyRevealedNotices);
        if (!background) setStatus({ kind: 'saved', at: result.answer.savedAt });
      } catch (error) {
        dirty.current = true;
        if (error instanceof ApiError && error.status === 410) {
          callbacks.current.onSessionEnded();
          return;
        }
        if (background) callbacks.current.onBackgroundError(`${subquestion.key} 답안을 저장하지 못했습니다: ${errorMessage(error)}`);
        else setStatus({ kind: 'error', message: errorMessage(error) });
      }
    },
    [subquestion.key],
  );
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // 입력이 멈추면 자동저장
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void persistRef.current(content, false), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [content]);

  // 다른 문항으로 옮기거나 화면을 닫을 때(편집기가 사라질 때만) 남은 변경을 저장
  useEffect(
    () => () => {
      if (dirty.current) void persistRef.current(latest.current, false, true);
    },
    [],
  );

  const change = (next: AnswerContent) => {
    dirty.current = true;
    setContent(next);
  };

  const submittedAndUnchanged = saved?.latestIsFinal === true && !dirty.current && JSON.stringify(saved.content) === JSON.stringify(content);
  const isEmpty = content.kind === 'text' ? content.text.trim().length === 0 : content.selected.length === 0 && (content.note ?? '').trim().length === 0;
  const note = subquestion.answer.kind === 'multi_choice' ? subquestion.answer.note : undefined;

  return (
    <div className="answer">
      {subquestion.answer.kind === 'text' && content.kind === 'text' ? (
        <label className="field">
          <span>{subquestion.key} 답안</span>
          <textarea className="textarea answer-text" value={content.text} rows={14} onChange={(e) => change({ kind: 'text', text: e.target.value })} />
        </label>
      ) : null}
      {subquestion.answer.kind === 'multi_choice' && content.kind === 'multi_choice' ? (
        <fieldset className="choices">
          <legend>해당하는 것을 모두 고르십시오</legend>
          {subquestion.answer.options.map((option) => {
            const checked = content.selected.includes(option.id);
            return (
              <label key={option.id} className="choice">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => change({ ...content, selected: checked ? content.selected.filter((id) => id !== option.id) : [...content.selected, option.id] })}
                />
                {option.label}
              </label>
            );
          })}
        </fieldset>
      ) : null}
      {note !== undefined && content.kind === 'multi_choice' ? (
        <label className="field">
          <span>{note.label}</span>
          <textarea className="textarea answer-note" value={content.note ?? ''} rows={3} onChange={(e) => change({ ...content, note: e.target.value })} />
        </label>
      ) : null}
      <div className="answer-actions">
        <span className="small muted" role="status">
          {status.kind === 'saving' && '저장 중'}
          {status.kind === 'saved' && `저장됨 ${formatClock(status.at)}`}
          {status.kind === 'error' && <span className="text-danger">저장 실패: {status.message}</span>}
          {saved?.lastSubmittedAt != null && ` 최종 제출 ${formatClock(saved.lastSubmittedAt)}`}
        </span>
        <button type="button" className="btn" disabled={isEmpty || status.kind === 'saving'} onClick={() => void persist(content, false)}>
          임시 저장
        </button>
        <button type="button" className="btn btn-primary" disabled={isEmpty || submittedAndUnchanged || status.kind === 'saving'} onClick={() => void persist(content, true)}>
          {saved?.lastSubmittedAt != null ? '다시 제출' : '최종 제출'}
        </button>
      </div>
    </div>
  );
}
