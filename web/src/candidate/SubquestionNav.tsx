import type { CandidateAnswerView, CandidateCaseView, CandidateMaterialView } from '@ai-measurement/shared';

interface SubquestionNavProps {
  caseView: CandidateCaseView;
  answers: ReadonlyMap<string, CandidateAnswerView>;
  /** 지금 보는 문항. 과제 설명 구역이면 null */
  reading: string | null;
  /** 문항(또는 과제 설명=null)으로 이동한다 */
  onJump: (subquestionKey: string | null) => void;
  onOpenMaterial: (material: CandidateMaterialView) => void;
}

function answerState(answer: CandidateAnswerView | undefined): { label: string; tone: 'done' | 'progress' | 'none' } {
  if (answer === undefined) return { label: '미작성', tone: 'none' };
  if (answer.latestIsFinal) return { label: '제출됨', tone: 'done' };
  if (answer.lastSubmittedAt !== null) return { label: '제출 후 수정 중', tone: 'progress' };
  return { label: '작성 중', tone: 'progress' };
}

/** 왼쪽 칸: 한 페이지 문서의 목차(누르면 그 문항으로 스크롤), 진행 상태, 자료 목록 */
export function SubquestionNav({ caseView, answers, reading, onJump, onOpenMaterial }: SubquestionNavProps) {
  return (
    <nav className="task-nav" aria-label={`${caseView.title} 문항`}>
      <button type="button" className="task-nav-item" aria-current={reading === null ? 'true' : undefined} onClick={() => onJump(null)}>
        과제 설명
      </button>
      <h2 className="task-nav-heading">하위문항</h2>
      <ol className="task-nav-list">
        {caseView.subquestions.map((sub) => {
          const state = answerState(answers.get(sub.key));
          return (
            <li key={sub.key}>
              <button type="button" className="task-nav-item" aria-current={reading === sub.key ? 'true' : undefined} onClick={() => onJump(sub.key)}>
                <span className="task-nav-key num">{sub.key}</span>
                <span className="task-nav-title">{sub.title}</span>
                <span className={`task-state task-state-${state.tone}`}>{state.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <h2 className="task-nav-heading">자료</h2>
      <ul className="task-nav-list">
        {caseView.materials.map((material) => (
          <li key={material.key}>
            <button type="button" className="task-nav-item" onClick={() => onOpenMaterial(material)}>
              <span className="task-nav-title">{material.title}</span>
              <span className="task-kind">{material.kind.toUpperCase()}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
