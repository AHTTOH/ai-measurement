import type { CandidateAnswerView, CandidateCaseView, CandidateNoticeView } from '@ai-measurement/shared';
import { useEffect, useRef, type ReactElement } from 'react';
import { AnswerEditor, answerCondition } from './AnswerEditor';

/** 문항 구역 id. 왼쪽 목차가 이 id로 스크롤한다 */
export function subquestionAnchor(key: string): string {
  return `sq-${key}`;
}

export const CASE_TOP_ANCHOR = 'case-top';

/** 화면 높이의 이 비율 선을 마지막으로 지난 구역을 '지금 보는 문항'으로 본다 */
const READING_LINE_RATIO = 0.35;

interface CaseDocumentProps {
  caseView: CandidateCaseView;
  answers: ReadonlyMap<string, CandidateAnswerView>;
  candidateNotice: string;
  onSaved: (answer: CandidateAnswerView, revealed: CandidateNoticeView[]) => void;
  onSessionEnded: () => void;
  onBackgroundError: (message: string) => void;
  /** 지금 보는 문항이 바뀌면 부른다(문항별 시간 기록, AI 대화의 문항 표시). 과제 설명 구역이면 null */
  onReading: (subquestionKey: string | null) => void;
}

/**
 * Case 하나를 위에서 아래로 이어지는 한 페이지로 보여 준다(2026-09-27 신영환 요청).
 * 과제 설명 → 받은 공지 → 문항마다 [번호·제목·지시문 → 답안 조건·유의사항 → 답안]이 이어진다.
 * 문항 사이에 유의사항과 조건이 끼어 있어, 페이지 전체를 그대로 AI에 붙여 넣는지도 행동으로 드러난다.
 */
export function CaseDocument({ caseView, answers, candidateNotice, onSaved, onSessionEnded, onBackgroundError, onReading }: CaseDocumentProps): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const onReadingRef = useRef(onReading);
  onReadingRef.current = onReading;

  useEffect(() => {
    const root = container.current;
    if (root === null) return;
    const sections = [...root.querySelectorAll<HTMLElement>('[data-reading-key]')];
    let frame = 0;
    let last: string | null | undefined;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight * READING_LINE_RATIO;
      const passed = sections.filter((section) => section.getBoundingClientRect().top <= line);
      const key = passed.at(-1)?.dataset['readingKey'];
      const next = key === undefined || key === CASE_TOP_ANCHOR ? null : key;
      if (next === last) return;
      last = next;
      onReadingRef.current(next);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    // 넓은 화면은 가운데 칸이, 좁은 화면은 페이지 전체가 스크롤된다. 둘 다 듣는다(capture로 칸의 스크롤도 받는다)
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [caseView.key, caseView.subquestions.length]);

  return (
    <div ref={container} className="case-document">
      <article className="task" id={CASE_TOP_ANCHOR} data-reading-key={CASE_TOP_ANCHOR}>
        <h1 className="task-title">{caseView.title}</h1>
        <p className="prewrap">{caseView.brief}</p>
        {caseView.notices.length > 0 && (
          <section className="task-notices">
            <h2 className="task-subheading">받은 공지</h2>
            {caseView.notices.map((n) => (
              <div key={n.key} className="notice notice-read">
                <p className="notice-from">보낸 사람: {n.from}</p>
                <h3 className="notice-title">{n.title}</h3>
                <p className="prewrap">{n.body}</p>
              </div>
            ))}
          </section>
        )}
        <p className="alert alert-caution small">{candidateNotice.split('\n')[0]}</p>
      </article>

      {caseView.subquestions.map((sub) => (
        <section key={sub.key} id={subquestionAnchor(sub.key)} data-reading-key={sub.key} className="task task-section" aria-labelledby={`${subquestionAnchor(sub.key)}-title`}>
          <p className="task-key num">{sub.key}</p>
          <h2 className="task-title" id={`${subquestionAnchor(sub.key)}-title`}>
            {sub.title}
          </h2>
          <p className="prewrap task-prompt">{sub.prompt}</p>
          <div className="task-conditions">
            <p className="task-condition">
              <strong>답안 조건</strong> {answerCondition(sub)}
            </p>
            {sub.guidance.length > 0 && (
              <div className="task-guidance">
                <strong>유의사항</strong>
                <ul>
                  {sub.guidance.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <AnswerEditor subquestion={sub} saved={answers.get(sub.key)} onSaved={onSaved} onSessionEnded={onSessionEnded} onBackgroundError={onBackgroundError} />
        </section>
      ))}
    </div>
  );
}
