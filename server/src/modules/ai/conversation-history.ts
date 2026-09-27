import type Anthropic from '@anthropic-ai/sdk';
import { tables, type DbExecutor, type StoredUserBlock } from '@ai-measurement/infra';
import { asc, eq, inArray } from 'drizzle-orm';

type AttachmentRecord = typeof tables.attachments.$inferSelect;

export interface AttachmentPayload {
  attachment: Pick<AttachmentRecord, 'id' | 'selection' | 'renderedText' | 'documentTitle'>;
  /** PDF 첨부의 보낸 바이트. CSV면 null */
  pdfBytes: Buffer | null;
}

/**
 * 저장한 사용자 블록을 API 블록으로 바꾼다. 새 메시지를 보낼 때와 대화 기록을 다시 보낼 때 모두 이 함수를 써서
 * 같은 메시지가 언제나 같은 바이트가 되게 한다(프롬프트 캐시 유지).
 */
export function userBlocksToApi(blocks: readonly StoredUserBlock[], attachments: ReadonlyMap<string, AttachmentPayload>): Anthropic.ContentBlockParam[] {
  return blocks.map((block): Anthropic.ContentBlockParam => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    const payload = attachments.get(block.attachmentId);
    if (payload === undefined) throw new Error(`첨부 기록이 없습니다: ${block.attachmentId}`);
    return attachmentToApiBlock(payload);
  });
}

function attachmentToApiBlock({ attachment, pdfBytes }: AttachmentPayload): Anthropic.ContentBlockParam {
  if (attachment.selection.kind === 'csv') {
    if (attachment.renderedText === null) throw new Error(`CSV 첨부의 전송 본문이 없습니다: ${attachment.id}`);
    return { type: 'text', text: attachment.renderedText };
  }
  if (pdfBytes === null || attachment.documentTitle === null) throw new Error(`PDF 첨부의 바이트 또는 제목이 없습니다: ${attachment.id}`);
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pdfBytes.toString('base64') },
    title: attachment.documentTitle,
  };
}

/**
 * 저장된 대화를 Claude API 요청 형태로 되돌린다.
 * - AI 응답은 받은 content 블록을 바꾸지 않고 다시 보낸다(thinking 블록 포함)
 * - 오류로 끝난 AI 메시지는 뺀다. 이 경우 사용자 메시지가 연달아 나오며 API가 합쳐서 처리한다
 */
export async function buildConversationHistory(executor: DbExecutor, conversationId: string): Promise<Anthropic.MessageParam[]> {
  const rows = await executor
    .select()
    .from(tables.messages)
    .where(eq(tables.messages.conversationId, conversationId))
    .orderBy(asc(tables.messages.seq));
  const messageIds = rows.map((r) => r.id);
  const attachmentRows =
    messageIds.length === 0
      ? []
      : await executor
          .select({ attachment: tables.attachments, bytes: tables.attachmentBlobs.bytes })
          .from(tables.attachments)
          .leftJoin(tables.attachmentBlobs, eq(tables.attachmentBlobs.sha256, tables.attachments.blobSha256))
          .where(inArray(tables.attachments.messageId, messageIds));
  const payloads = new Map<string, AttachmentPayload>(
    attachmentRows.map((row) => [row.attachment.id, { attachment: row.attachment, pdfBytes: row.bytes }]),
  );

  const history: Anthropic.MessageParam[] = [];
  for (const message of rows) {
    if (message.role === 'assistant') {
      if (message.status === 'complete') history.push({ role: 'assistant', content: message.content as Anthropic.ContentBlockParam[] });
      continue;
    }
    history.push({ role: 'user', content: userBlocksToApi(message.content as StoredUserBlock[], payloads) });
  }
  return history;
}
