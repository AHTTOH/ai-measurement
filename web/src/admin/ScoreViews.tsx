import { AXES, AXIS_LABELS, type SessionScoreView } from '@ai-measurement/shared';
import type { ReactElement } from 'react';
import { formatScore } from '../ui/format';

/** 표 안에서 비교되도록 숫자 옆에 가는 막대를 함께 그린다(차트를 따로 두지 않는다) */
export function ScoreBar({ value }: { value: number | null }): ReactElement {
  return (
    <span className="score-cell">
      <span className="num">{formatScore(value)}</span>
      {value !== null && (
        <span className="score-bar" aria-hidden="true">
          <span className="score-bar-fill" style={{ transform: `scaleX(${Math.min(100, Math.max(0, value)) / 100})` }} />
        </span>
      )}
    </span>
  );
}

const OUTCOME_LABELS: Readonly<Record<SessionScoreView['outcome'], string>> = {
  clear: '이상 없음',
  flagged: '위반 표시',
  review: '검토 필요',
  fail: '불합격(위반)',
};

export function OutcomeLabel({ outcome }: { outcome: SessionScoreView['outcome'] }): ReactElement {
  return <span className={`outcome outcome-${outcome}`}>{OUTCOME_LABELS[outcome]}</span>;
}

export function isMockGraded(score: SessionScoreView): boolean {
  return score.graderKinds.includes('llm-mock');
}

/** PRD 8장 형식 요약: AI 실무역량 78 / 100, 그 아래 세 축 */
export function ScoreSummary({ score }: { score: SessionScoreView }): ReactElement {
  return (
    <section className="score-summary" aria-label="점수 요약">
      <div className="score-total">
        <span className="score-total-label">AI 실무역량</span>
        <span className="score-total-value num">{formatScore(score.total)}</span>
        <span className="muted num">/ 100</span>
        {isMockGraded(score) && <span className="mock-flag">모의 채점</span>}
      </div>
      <dl className="score-axes">
        {AXES.map((axis) => (
          <div key={axis}>
            <dt>{AXIS_LABELS[axis]}</dt>
            <dd>
              <ScoreBar value={score.axisPercent[axis]} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="small">
        중대 보안 위반 <strong className="num">{score.violationCount}</strong>건 <OutcomeLabel outcome={score.outcome} />
      </p>
    </section>
  );
}
