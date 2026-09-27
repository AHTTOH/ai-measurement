import type Anthropic from '@anthropic-ai/sdk';
import type { tables } from '@ai-measurement/infra';
import type { AttachmentSelectionView, ChatAttachmentView, ChatMessageView } from '@ai-measurement/shared';
import { AI_FAILURE_MESSAGES, type AiFailureKind } from './ai-gateway';

export type MessageRecord = typeof tables.messages.$inferSelect;
export type AttachmentRecord = typeof tables.attachments.$inferSelect;

export function selectionView(selection: AttachmentRecord['selection']): AttachmentSelectionView {
  return selection.kind === 'csv'
    ? { kind: 'csv', columns: selection.columns, rowCount: selection.rowIndexes.length }
    : { kind: 'pdf', pageFrom: selection.pageFrom, pageTo: selection.pageTo };
}

export function attachmentView(attachment: AttachmentRecord, materialTitles: ReadonlyMap<string, string>): ChatAttachmentView {
  const materialTitle = materialTitles.get(attachment.materialKey);
  if (materialTitle === undefined) {
    // 첨부는 시험 정의의 자료로만 만들 수 있으므로 여기 오면 데이터가 어긋난 것이다
    throw new Error(`시험 정의에 없는 자료의 첨부입니다: ${attachment.materialKey}`);
  }
  return { id: attachment.id, materialKey: attachment.materialKey, materialTitle, selection: selectionView(attachment.selection) };
}

export function messageView(
  message: MessageRecord,
  attachments: readonly AttachmentRecord[],
  materialTitles: ReadonlyMap<string, string>,
): ChatMessageView {
  const errorKind = message.error?.type as AiFailureKind | undefined;
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    subquestionKey: message.subquestionKey,
    text: message.plainText,
    attachments: attachments.filter((a) => a.messageId === message.id).map((a) => attachmentView(a, materialTitles)),
    chargedTokens: message.chargedTokens,
    status: message.status,
    stopReason: message.stopReason,
    errorMessage: message.status === 'error' ? failureMessage(errorKind) : null,
    provider: message.provider,
    createdAt: message.createdAt.toISOString(),
  };
}

function failureMessage(kind: AiFailureKind | undefined): string {
  // in 연산자는 constructor 같은 기본 속성도 참으로 본다. 자기 속성만 인정한다
  if (kind === undefined || !Object.hasOwn(AI_FAILURE_MESSAGES, kind)) {
    throw new Error(`오류 메시지에 알 수 없는 실패 종류가 기록되어 있습니다: ${String(kind)}`);
  }
  return AI_FAILURE_MESSAGES[kind];
}

/** AI 응답에서 사람이 읽을 텍스트만 뽑는다(thinking 블록 제외) */
export function assistantPlainText(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}
