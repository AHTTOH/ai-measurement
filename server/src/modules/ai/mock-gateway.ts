import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { AiCompletion, AiConversationRequest, AiCountRequest, AiGateway } from './ai-gateway';

/**
 * 개발·테스트용 모의 AI. 실제 AI가 아니며 응답 첫 줄에 그 사실을 적는다.
 * 토큰 수도 글자 수로 만든 근사치다. AI_PROVIDER=mock을 명시했을 때만 쓴다.
 */

/** 모의 토큰 환산: 글자 2개를 1토큰으로 본다 */
const CHARS_PER_MOCK_TOKEN = 2;
/** 모의 토큰 환산: PDF base64 800자를 1토큰으로 본다 */
const PDF_BASE64_CHARS_PER_MOCK_TOKEN = 800;
const PER_MESSAGE_OVERHEAD = 4;
const CHUNK_CHARS = 12;

export interface MockGatewayOptions {
  /** 응답 조각 사이 지연(ms). 스트리밍 화면 확인과 부하 테스트에 쓴다 */
  chunkDelayMs: number;
}

function blockText(block: Anthropic.ContentBlockParam): { chars: number; pdfTokens: number; text: string } {
  if (block.type === 'text') return { chars: block.text.length, pdfTokens: 0, text: block.text };
  if (block.type === 'document' && block.source.type === 'base64') {
    return { chars: 0, pdfTokens: Math.ceil(block.source.data.length / PDF_BASE64_CHARS_PER_MOCK_TOKEN), text: '' };
  }
  return { chars: 0, pdfTokens: 0, text: '' };
}

function messageBlocks(message: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
}

export class MockGateway implements AiGateway {
  readonly provider = 'mock' as const;

  constructor(private readonly options: MockGatewayOptions) {}

  async countTokens(request: AiCountRequest): Promise<number> {
    let tokens = request.systemPrompt !== null ? Math.ceil(request.systemPrompt.length / CHARS_PER_MOCK_TOKEN) : 0;
    for (const message of request.messages) {
      tokens += PER_MESSAGE_OVERHEAD;
      for (const block of messageBlocks(message)) {
        const measured = blockText(block);
        tokens += Math.ceil(measured.chars / CHARS_PER_MOCK_TOKEN) + measured.pdfTokens;
      }
    }
    return tokens;
  }

  async streamConversation(request: AiConversationRequest, onText: (delta: string) => void): Promise<AiCompletion> {
    const last = request.messages.at(-1);
    const blocks = last !== undefined ? messageBlocks(last) : [];
    const documents = blocks.filter((b) => b.type === 'document').length;
    const text = blocks.map((b) => blockText(b).text).join('\n');
    const excerpt = text.replace(/\s+/gu, ' ').trim().slice(0, 80);
    const reply = [
      '[모의 AI 응답] 실제 AI가 아닌 개발용 응답입니다.',
      `이번 요청: 본문 ${text.length.toLocaleString('ko-KR')}자, PDF ${documents}건, 대화 ${request.messages.length}턴째.`,
      `요청 앞부분: ${excerpt}`,
    ].join('\n');

    for (let i = 0; i < reply.length; i += CHUNK_CHARS) {
      if (this.options.chunkDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.chunkDelayMs));
      onText(reply.slice(i, i + CHUNK_CHARS));
    }
    const inputTokens = await this.countTokens({ model: request.model, systemPrompt: request.systemPrompt, messages: request.messages });
    return {
      providerMessageId: `mock_${randomUUID()}`,
      model: `mock:${request.model}`,
      content: [{ type: 'text', text: reply, citations: null }],
      stopReason: 'end_turn',
      usage: {
        input_tokens: inputTokens,
        output_tokens: Math.ceil(reply.length / CHARS_PER_MOCK_TOKEN),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      requestId: null,
    };
  }
}
