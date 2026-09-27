import { AXES, type Axis, type ViolationPolicy } from '@ai-measurement/shared';
import type { ItemResult } from '../rules/item-result';

export interface SessionScore {
  status: 'graded' | 'incomplete';
  /** 가중 총점(0~100). 미채점 항목이 하나라도 있으면 null */
  total: number | null;
  /** 축별 득점률(0~100). 그 축에 미채점 항목이 있으면 null */
  axisPercent: Record<Axis, number | null>;
  violationCount: number;
  outcome: 'clear' | 'flagged' | 'review' | 'fail';
}

const OUTCOME_BY_POLICY: Readonly<Record<ViolationPolicy, SessionScore['outcome']>> = {
  flag_only: 'flagged',
  review: 'review',
  fail: 'fail',
};

/**
 * PRD 8장 채점 구조. 축별 득점률 = 모든 Case의 해당 축 득점 합 / 배점 합.
 * 총점 = 축별 득점률 × 시험의 축 가중치(30·35·35 등) 합.
 */
export function scoreSession(items: readonly ItemResult[], weights: Readonly<Record<Axis, number>>, violationCount: number, policy: ViolationPolicy): SessionScore {
  const axisPercent = Object.fromEntries(
    AXES.map((axis) => {
      const axisItems = items.filter((i) => i.axis === axis);
      const points = axisItems.reduce((acc, i) => acc + i.points, 0);
      if (points === 0) throw new Error(`축 '${axis}'에 배점이 없습니다. 루브릭을 확인하십시오`);
      if (axisItems.some((i) => i.earned === null)) return [axis, null];
      const earned = axisItems.reduce((acc, i) => acc + (i.earned as number), 0);
      return [axis, (earned / points) * 100];
    }),
  ) as Record<Axis, number | null>;
  const complete = AXES.every((axis) => axisPercent[axis] !== null);
  const total = complete ? AXES.reduce((acc, axis) => acc + ((axisPercent[axis] as number) * weights[axis]) / 100, 0) : null;
  return {
    status: complete ? 'graded' : 'incomplete',
    total,
    axisPercent,
    violationCount,
    outcome: violationCount === 0 ? 'clear' : OUTCOME_BY_POLICY[policy],
  };
}
