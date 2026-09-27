import type { AiProviderName, CandidateCaseView } from '@ai-measurement/shared';
import { formatNumber, formatRemaining } from '../ui/format';
import { timeLevel, tokenLevel } from '../ui/resource-levels';

interface ConsoleBarProps {
  examTitle: string;
  candidateNo: string;
  cases: CandidateCaseView[];
  activeCaseKey: string;
  onSelectCase: (caseKey: string) => void;
  tokenBalance: number;
  tokenBudget: number;
  remainingMs: number;
  aiProvider: AiProviderName;
  onEndExam: () => void;
}

/** 상단 계기판: 시험 정보, Case 전환, 남은 토큰과 남은 시간(화면에서 유일하게 대담한 영역) */
export function ConsoleBar(props: ConsoleBarProps) {
  const tokens = tokenLevel(props.tokenBalance, props.tokenBudget);
  const time = timeLevel(props.remainingMs);
  const usedRatio = props.tokenBudget > 0 ? 1 - props.tokenBalance / props.tokenBudget : 1;
  return (
    <header className="console">
      <div className="console-identity">
        <span className="console-title">{props.examTitle}</span>
        <span className="console-candidate num">{props.candidateNo}</span>
        {props.aiProvider === 'mock' && <span className="console-badge">모의 AI</span>}
      </div>
      <nav className="console-cases" aria-label="Case 전환">
        {props.cases.map((c, index) => (
          <button
            key={c.key}
            type="button"
            className="console-case"
            aria-current={c.key === props.activeCaseKey ? 'page' : undefined}
            onClick={() => props.onSelectCase(c.key)}
          >
            <span className="num">{index + 1}</span> {c.title}
          </button>
        ))}
      </nav>
      <div className="console-readouts">
        <div className={`readout readout-${tokens}`} role="status" aria-label={`남은 토큰 ${formatNumber(props.tokenBalance)}`}>
          <span className="readout-label">남은 토큰</span>
          <span className="readout-value num">{formatNumber(props.tokenBalance)}</span>
          <span className="readout-sub num">/ {formatNumber(props.tokenBudget)}</span>
          <span className="gauge" aria-hidden="true">
            <span className="gauge-used" style={{ transform: `scaleX(${Math.min(1, Math.max(0, usedRatio))})` }} />
          </span>
        </div>
        <div className={`readout readout-${time}`} role="timer" aria-label={`남은 시간 ${formatRemaining(props.remainingMs)}`}>
          <span className="readout-label">남은 시간</span>
          <span className="readout-value num">{formatRemaining(props.remainingMs)}</span>
        </div>
        <button type="button" className="btn console-end" onClick={props.onEndExam}>
          시험 종료
        </button>
      </div>
    </header>
  );
}
