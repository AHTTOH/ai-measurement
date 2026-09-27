/**
 * PRD 3장: 평가항목은 3개로 통일한다.
 * 축 식별자와 표시 이름은 PRD가 정한 도메인 상수다. 배점(가중치)은 시험 패키지에서 온다.
 */
export const AXES = ['judgment', 'usage', 'output'] as const;

export type Axis = (typeof AXES)[number];

export const AXIS_LABELS: Readonly<Record<Axis, string>> = {
  judgment: '정보 판단',
  usage: 'AI 활용·검증',
  output: '업무 결과물',
};
