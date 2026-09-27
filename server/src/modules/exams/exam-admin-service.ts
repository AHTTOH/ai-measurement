import { tables, type Database } from '@ai-measurement/infra';
import type { GeneratedCandidate } from '@ai-measurement/shared';
import { eq, like } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import type { Clock } from '../../lib/clock';
import { hashSecret, randomDigits } from '../../lib/secrets';
import { actorOf, writeAudit } from '../audit/audit-log';
import type { ExamCatalog } from './exam-catalog';

/** PIN 자릿수. 응시자가 손으로 입력하므로 짧게 두고, 계정별 로그인 잠금으로 무차별 대입을 막는다 */
export const PIN_DIGITS = 6;
const CANDIDATE_NUMBER_DIGITS = 4;

const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ['open'],
  open: ['closed'],
  closed: [],
};

/** 시험 상태 전환과 응시자 발급 */
export class ExamAdminService {
  constructor(
    private readonly db: Database,
    private readonly catalog: ExamCatalog,
    private readonly clock: Clock,
  ) {}

  async changeStatus(examId: string, next: 'open' | 'closed', adminId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [exam] = await tx.select({ status: tables.exams.status }).from(tables.exams).where(eq(tables.exams.id, examId)).for('update').limit(1);
      if (exam === undefined) throw appErrors.notFound('exam_not_found', '시험을 찾을 수 없습니다');
      if (!(ALLOWED_TRANSITIONS[exam.status] ?? []).includes(next)) {
        throw appErrors.conflict('invalid_status_transition', `${exam.status} 상태에서 ${next}(으)로 바꿀 수 없습니다`);
      }
      const now = this.clock.now();
      await tx
        .update(tables.exams)
        .set(next === 'open' ? { status: next, openedAt: now } : { status: next, closedAt: now })
        .where(eq(tables.exams.id, examId));
      await writeAudit(tx, { examId, examSessionId: null, actor: actorOf.admin(adminId), kind: 'exam_status_changed', payload: { from: exam.status, to: next } });
    });
  }

  /**
   * 응시번호(접두사 + 일련번호)와 PIN을 발급한다. PIN 원문은 이 반환값에서만 볼 수 있다.
   * 응시번호는 모든 시험에서 유일하다(로그인 화면에 시험 선택이 없으므로).
   */
  async generateCandidates(examId: string, prefix: string, count: number, adminId: string): Promise<GeneratedCandidate[]> {
    const exam = await this.catalog.get(examId);
    if (exam.status === 'closed') throw appErrors.conflict('exam_closed', '종료된 시험에는 응시자를 추가할 수 없습니다');

    const existing = await this.db
      .select({ candidateNo: tables.candidates.candidateNo })
      .from(tables.candidates)
      .where(like(tables.candidates.candidateNo, `${prefix}%`));
    const suffixPattern = new RegExp(`^${prefix}(\\d{${CANDIDATE_NUMBER_DIGITS}})$`, 'u');
    const maxExisting = existing.reduce((max, row) => {
      const match = suffixPattern.exec(row.candidateNo);
      return match?.[1] !== undefined ? Math.max(max, Number(match[1])) : max;
    }, 0);
    if (maxExisting + count >= 10 ** CANDIDATE_NUMBER_DIGITS) {
      throw appErrors.conflict('candidate_numbers_exhausted', '이 접두사로 발급할 수 있는 응시번호가 부족합니다. 다른 접두사를 쓰십시오');
    }

    const generated: GeneratedCandidate[] = Array.from({ length: count }, (_, i) => ({
      candidateNo: `${prefix}${String(maxExisting + i + 1).padStart(CANDIDATE_NUMBER_DIGITS, '0')}`,
      pin: randomDigits(PIN_DIGITS),
    }));
    const rows = await Promise.all(
      generated.map(async (g) => ({ examId, candidateNo: g.candidateNo, pinHash: await hashSecret(g.pin) })),
    );
    await this.db.transaction(async (tx) => {
      await tx.insert(tables.candidates).values(rows);
      await writeAudit(tx, {
        examId,
        examSessionId: null,
        actor: actorOf.admin(adminId),
        kind: 'candidates_generated',
        payload: { prefix, count, first: generated[0]?.candidateNo ?? null, last: generated.at(-1)?.candidateNo ?? null },
      });
    });
    return generated;
  }
}
