import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AI_FAILURE_MESSAGES } from '../../../server/src/modules/ai/ai-gateway';
import {
  assistantPlainText,
  attachmentView,
  messageView,
  selectionView,
  type AttachmentRecord,
  type MessageRecord,
} from '../../../server/src/modules/ai/message-views';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date(Date.UTC(2026, 8, 27, 1, 2, 3));
const MATERIAL_TITLES: ReadonlyMap<string, string> = new Map([
  ['survey', '직원 설문 CSV'],
  ['report', '연간 보고서 PDF'],
]);

function messageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: MESSAGE_ID,
    conversationId: '44444444-4444-4444-8444-444444444444',
    examSessionId: SESSION_ID,
    seq: 2,
    role: 'assistant',
    subquestionKey: '1-1',
    clientMessageId: null,
    content: [],
    plainText: '분석 결과입니다',
    chargedTokens: 120,
    contextTokens: 300,
    patternHits: null,
    provider: 'mock',
    model: 'mock:model',
    status: 'complete',
    stopReason: 'end_turn',
    usage: null,
    latencyMs: 15,
    providerRequestId: null,
    providerMessageId: null,
    error: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function attachmentRecord(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    messageId: MESSAGE_ID,
    examSessionId: SESSION_ID,
    materialKey: 'survey',
    selection: { kind: 'csv', columns: ['부서', '점수'], rowIndexes: [0, 2, 5] },
    renderedText: '부서,점수',
    blobSha256: null,
    documentTitle: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('첨부 선택 범위 보기', () => {
  it('CSV 선택은 열 이름과 행 수만 보여준다(행 번호는 숨긴다)', () => {
    expect(selectionView({ kind: 'csv', columns: ['부서'], rowIndexes: [3, 4, 9, 10] })).toEqual({ kind: 'csv', columns: ['부서'], rowCount: 4 });
  });

  it('PDF 선택은 쪽 범위를 보여준다', () => {
    expect(selectionView({ kind: 'pdf', pageFrom: 2, pageTo: 5 })).toEqual({ kind: 'pdf', pageFrom: 2, pageTo: 5 });
  });
});

describe('첨부 보기', () => {
  it('자료 제목을 붙여 보여준다', () => {
    const attachment = attachmentRecord({ materialKey: 'report', selection: { kind: 'pdf', pageFrom: 1, pageTo: 1 } });

    expect(attachmentView(attachment, MATERIAL_TITLES)).toEqual({
      id: attachment.id,
      materialKey: 'report',
      materialTitle: '연간 보고서 PDF',
      selection: { kind: 'pdf', pageFrom: 1, pageTo: 1 },
    });
  });

  it('시험 정의에 없는 자료의 첨부면 데이터 어긋남으로 오류를 던진다', () => {
    const attachment = attachmentRecord({ materialKey: 'deleted-material' });

    expect(() => attachmentView(attachment, MATERIAL_TITLES)).toThrow('시험 정의에 없는 자료의 첨부입니다: deleted-material');
  });
});

describe('메시지 보기', () => {
  it('정상 응답은 이 메시지의 첨부만 골라 붙이고 오류 문구는 비운다', () => {
    // Arrange
    const own = attachmentRecord({ id: 'a-own' });
    const other = attachmentRecord({ id: 'a-other', messageId: OTHER_MESSAGE_ID });

    // Act
    const view = messageView(messageRecord(), [own, other], MATERIAL_TITLES);

    // Assert
    expect(view).toEqual({
      id: MESSAGE_ID,
      seq: 2,
      role: 'assistant',
      subquestionKey: '1-1',
      text: '분석 결과입니다',
      attachments: [{ id: 'a-own', materialKey: 'survey', materialTitle: '직원 설문 CSV', selection: { kind: 'csv', columns: ['부서', '점수'], rowCount: 3 } }],
      chargedTokens: 120,
      status: 'complete',
      stopReason: 'end_turn',
      errorMessage: null,
      provider: 'mock',
      createdAt: '2026-09-27T01:02:03.000Z',
    });
  });

  it('정상 응답이면 error 칸에 값이 있어도 오류 문구를 만들지 않는다', () => {
    const view = messageView(messageRecord({ error: { type: 'mystery', message: 'x', status: null } }), [], MATERIAL_TITLES);

    expect(view.errorMessage).toBeNull();
  });

  it.each(Object.entries(AI_FAILURE_MESSAGES))('실패 종류 %s는 응시자용 안내 문구로 바꾼다', (kind, expected) => {
    const message = messageRecord({ status: 'error', plainText: '', error: { type: kind, message: 'internal detail', status: 500 } });

    const view = messageView(message, [], MATERIAL_TITLES);

    expect(view.errorMessage).toBe(expected);
    expect(view.errorMessage).not.toContain('internal detail');
  });

  it('오류 메시지인데 실패 종류가 기록되지 않았으면 오류를 던진다', () => {
    const message = messageRecord({ status: 'error', error: null });

    expect(() => messageView(message, [], MATERIAL_TITLES)).toThrow('오류 메시지에 알 수 없는 실패 종류가 기록되어 있습니다: undefined');
  });

  it('실패 종류가 객체 기본 속성 이름(constructor 등)이어도 목록에 없는 종류로 보고 오류를 던진다', () => {
    const message = messageRecord({ status: 'error', error: { type: 'constructor', message: 'x', status: null } });

    expect(() => messageView(message, [], MATERIAL_TITLES)).toThrow('오류 메시지에 알 수 없는 실패 종류가 기록되어 있습니다: constructor');
  });

  it('오류 메시지의 실패 종류가 목록에 없으면 오류를 던진다', () => {
    const message = messageRecord({ status: 'error', error: { type: 'solar_flare', message: 'x', status: null } });

    expect(() => messageView(message, [], MATERIAL_TITLES)).toThrow('오류 메시지에 알 수 없는 실패 종류가 기록되어 있습니다: solar_flare');
  });
});

describe('AI 응답 텍스트 추출', () => {
  it('text 블록만 빈 줄로 이어 붙이고 thinking 블록은 뺀다', () => {
    // Arrange
    const content: Anthropic.ContentBlock[] = [
      { type: 'thinking', thinking: '속으로 생각', signature: 'sig' },
      { type: 'text', text: '첫 문단', citations: null },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: '둘째 문단', citations: null },
    ];

    // Act
    const text = assistantPlainText(content);

    // Assert
    expect(text).toBe('첫 문단\n\n둘째 문단');
  });

  it('text 블록이 없으면 빈 문자열이다', () => {
    expect(assistantPlainText([{ type: 'thinking', thinking: '생각만', signature: 'sig' }])).toBe('');
    expect(assistantPlainText([])).toBe('');
  });
});
