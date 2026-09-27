import { z } from 'zod';
import type { AnswerFormat } from '../exam-package/exam-definition-schema';
import { keySchema } from '../exam-package/common-schema';

/** 서술형 답안 한 개의 최대 글자 수. 비정상 입력으로 DB가 부풀지 않게 막는 시스템 한도 */
export const MAX_TEXT_ANSWER_CHARS = 50_000;
/** 선택형 비고 칸의 최대 글자 수 */
export const MAX_CHOICE_NOTE_CHARS = 2_000;

export const answerContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().max(MAX_TEXT_ANSWER_CHARS) }),
  z.strictObject({ kind: z.literal('multi_choice'), selected: z.array(keySchema).max(50), note: z.string().max(MAX_CHOICE_NOTE_CHARS).optional() }),
]);

export type AnswerContent = z.infer<typeof answerContentSchema>;

/** 하위문항의 답안 형식과 맞지 않으면 사유를, 맞으면 null을 돌려준다. */
export function answerFormatMismatch(format: AnswerFormat, content: AnswerContent): string | null {
  if (format.kind !== content.kind) {
    return `이 하위문항은 ${format.kind === 'text' ? '서술형' : '선택형'} 답안만 받습니다`;
  }
  if (format.kind === 'multi_choice' && content.kind === 'multi_choice') {
    const valid = new Set(format.options.map((o) => o.id));
    const unknown = content.selected.filter((id) => !valid.has(id));
    if (unknown.length > 0) return `없는 선택지입니다: ${unknown.join(', ')}`;
    if (new Set(content.selected).size !== content.selected.length) return '같은 선택지를 두 번 고를 수 없습니다';
    if (content.note !== undefined && format.note === undefined) return '이 하위문항에는 비고 칸이 없습니다';
  }
  return null;
}

export function answerContentsEqual(a: AnswerContent, b: AnswerContent): boolean {
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
  if (a.kind === 'multi_choice' && b.kind === 'multi_choice') {
    return [...a.selected].sort().join('\u0000') === [...b.selected].sort().join('\u0000') && (a.note ?? '') === (b.note ?? '');
  }
  return false;
}
