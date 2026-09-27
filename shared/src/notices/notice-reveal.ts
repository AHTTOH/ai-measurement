import type { CaseDefinition, SubquestionDefinition } from '../exam-package/exam-definition-schema';

/**
 * PRD 7장 진행 중 조건 변경. 공지가 언제 열리는지 계산한다.
 * 서버(화면 노출)와 채점(공지 이후 수정 여부)이 같은 계산을 쓴다.
 */

export interface RevealContext {
  sessionStartedAt: Date;
  /** 하위문항별 최초 최종 제출 시각 */
  firstFinalSubmissionAt: ReadonlyMap<string, Date>;
  now: Date;
}

const MS_PER_MINUTE = 60_000;

/** now까지 열린 공지와 그 공개 시각 */
export function computeNoticeRevealTimes(caseDef: CaseDefinition, context: RevealContext): Map<string, Date> {
  const revealed = new Map<string, Date>();
  for (const notice of caseDef.notices) {
    const revealAt =
      notice.reveal.after === 'elapsed_minutes'
        ? new Date(context.sessionStartedAt.getTime() + notice.reveal.minutes * MS_PER_MINUTE)
        : context.firstFinalSubmissionAt.get(notice.reveal.subquestion);
    if (revealAt !== undefined && revealAt.getTime() <= context.now.getTime()) {
      revealed.set(notice.key, revealAt);
    }
  }
  return revealed;
}

export function isSubquestionVisible(subquestion: SubquestionDefinition, revealedNotices: ReadonlyMap<string, Date>): boolean {
  return subquestion.unlockedByNotice === null || revealedNotices.has(subquestion.unlockedByNotice);
}
