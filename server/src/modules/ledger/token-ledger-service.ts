import { tables, type Database, type DbExecutor, type Transaction } from '@ai-measurement/infra';
import type { LedgerEntryView } from '@ai-measurement/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { appErrors } from '../../lib/app-error';
import { actorOf, writeAudit } from '../audit/audit-log';

/**
 * 토큰 원장(PRD 6장). 행을 추가만 하고, 잔액은 항상 마지막 행의 balance_after다.
 * 차감·환불은 호출자가 exam_sessions 행을 FOR UPDATE로 잠근 트랜잭션 안에서 한다.
 */
export class TokenLedgerService {
  constructor(private readonly db: Database) {}

  async balance(executor: DbExecutor, examSessionId: string): Promise<number> {
    const [last] = await executor
      .select({ balanceAfter: tables.tokenLedger.balanceAfter })
      .from(tables.tokenLedger)
      .where(eq(tables.tokenLedger.examSessionId, examSessionId))
      .orderBy(desc(tables.tokenLedger.id))
      .limit(1);
    if (last === undefined) {
      // 세션 시작 시 initial 행을 반드시 만든다. 없으면 데이터 무결성 문제이므로 기본값으로 메우지 않는다.
      throw new Error(`토큰 원장이 비어 있습니다: ${examSessionId}`);
    }
    return last.balanceAfter;
  }

  async initialize(tx: Transaction, examSessionId: string, budget: number, actor: string): Promise<void> {
    await tx.insert(tables.tokenLedger).values({ examSessionId, delta: budget, balanceAfter: budget, reason: 'initial', actor });
  }

  /** 잔액 확인 후 차감. 잔액이 모자라면 409 */
  async charge(tx: Transaction, input: { examSessionId: string; messageId: string; amount: number; actor: string }): Promise<number> {
    const balance = await this.balance(tx, input.examSessionId);
    if (balance < input.amount) throw insufficientTokens(balance, input.amount);
    const balanceAfter = balance - input.amount;
    await tx.insert(tables.tokenLedger).values({
      examSessionId: input.examSessionId,
      messageId: input.messageId,
      delta: -input.amount,
      balanceAfter,
      reason: 'message',
      actor: input.actor,
    });
    return balanceAfter;
  }

  /** 운영자 환불(결정 D12). 같은 메시지는 한 번만 환불한다 */
  async refund(examSessionId: string, messageId: string, reason: string, adminId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: tables.examSessions.id }).from(tables.examSessions).where(eq(tables.examSessions.id, examSessionId)).for('update');
      const [message] = await tx
        .select()
        .from(tables.messages)
        .where(and(eq(tables.messages.id, messageId), eq(tables.messages.examSessionId, examSessionId)))
        .limit(1);
      if (message === undefined || message.role !== 'user' || message.chargedTokens === null || message.chargedTokens <= 0) {
        throw appErrors.badRequest('not_refundable', '이 세션에서 토큰을 차감한 응시자 메시지가 아닙니다');
      }
      const [previous] = await tx
        .select({ id: tables.tokenLedger.id })
        .from(tables.tokenLedger)
        .where(and(eq(tables.tokenLedger.messageId, messageId), eq(tables.tokenLedger.reason, 'refund')))
        .limit(1);
      if (previous !== undefined) throw appErrors.conflict('already_refunded', '이미 환불한 메시지입니다');

      const balance = await this.balance(tx, examSessionId);
      const balanceAfter = balance + message.chargedTokens;
      await tx.insert(tables.tokenLedger).values({
        examSessionId,
        messageId,
        delta: message.chargedTokens,
        balanceAfter,
        reason: 'refund',
        note: reason,
        actor: actorOf.admin(adminId),
      });
      await writeAudit(tx, {
        examId: null,
        examSessionId,
        actor: actorOf.admin(adminId),
        kind: 'tokens_refunded',
        payload: { messageId, amount: message.chargedTokens, reason },
      });
      return balanceAfter;
    });
  }

  async entries(examSessionId: string): Promise<LedgerEntryView[]> {
    const rows = await this.db
      .select()
      .from(tables.tokenLedger)
      .where(eq(tables.tokenLedger.examSessionId, examSessionId))
      .orderBy(asc(tables.tokenLedger.id));
    return rows.map((r) => ({
      id: r.id,
      messageId: r.messageId,
      delta: r.delta,
      balanceAfter: r.balanceAfter,
      reason: r.reason,
      note: r.note,
      actor: r.actor,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

export function insufficientTokens(balance: number, required: number) {
  return appErrors.conflict(
    'insufficient_tokens',
    `남은 토큰(${balance.toLocaleString('ko-KR')})이 이번 전송에 필요한 토큰(${required.toLocaleString('ko-KR')})보다 적습니다`,
    { balance, required },
  );
}
