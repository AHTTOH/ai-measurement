import { tables, type DbExecutor } from '@ai-measurement/infra';

/** 서버에서 일어난 일을 남기는 감사 로그. 추가만 한다 */
export interface AuditEntry {
  examId: string | null;
  examSessionId: string | null;
  /** 'system' | 'candidate:<id>' | 'admin:<id>' */
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
}

export async function writeAudit(executor: DbExecutor, entry: AuditEntry): Promise<void> {
  await executor.insert(tables.auditEvents).values(entry);
}

export const actorOf = {
  system: 'system',
  candidate: (candidateId: string) => `candidate:${candidateId}`,
  admin: (adminId: string) => `admin:${adminId}`,
};
