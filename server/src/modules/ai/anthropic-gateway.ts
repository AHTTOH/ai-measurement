import Anthropic from '@anthropic-ai/sdk';
import { AiGatewayError, type AiCompletion, type AiConversationRequest, type AiCountRequest, type AiGateway } from './ai-gateway';

/**
 * Claude API 구현. 공식 SDK(@anthropic-ai/sdk) 문서의 호출 형태를 따른다.
 * - thinking 파라미터는 생략한다(Sonnet 5는 생략 시 adaptive로 동작, 결정 D16)
 * - 시스템 프롬프트 블록에 캐시 지점을 두고, 요청 최상위 자동 캐싱으로 대화 꼬리를 캐시한다(구현계획 4.2)
 * - 실제 호출 검증은 API 키 발급 후 한다(결정: AI 모의 게이트웨이)
 */
export class AnthropicGateway implements AiGateway {
  readonly provider = 'anthropic' as const;

  constructor(private readonly client: Anthropic) {}

  async countTokens(request: AiCountRequest): Promise<number> {
    try {
      const result = await this.client.messages.countTokens({
        model: request.model,
        messages: request.messages,
        ...(request.systemPrompt !== null ? { system: [{ type: 'text' as const, text: request.systemPrompt }] } : {}),
      });
      return result.input_tokens;
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  async streamConversation(request: AiConversationRequest, onText: (delta: string) => void): Promise<AiCompletion> {
    try {
      const stream = this.client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens,
        system: [{ type: 'text', text: request.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: request.messages,
        output_config: { effort: request.effort },
        cache_control: { type: 'ephemeral' },
      });
      stream.on('text', onText);
      const message = await stream.finalMessage();
      return {
        providerMessageId: message.id,
        model: message.model,
        content: message.content,
        stopReason: message.stop_reason,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
          cache_read_input_tokens: message.usage.cache_read_input_tokens,
        },
        requestId: stream.request_id ?? null,
      };
    } catch (error) {
      throw toGatewayError(error);
    }
  }
}

function toGatewayError(error: unknown): AiGatewayError {
  if (error instanceof AiGatewayError) return error;
  if (error instanceof Anthropic.RateLimitError) return new AiGatewayError(error.message, 'rate_limited', 429);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiGatewayError(error.message, 'auth', error.status);
  }
  if (error instanceof Anthropic.BadRequestError) return new AiGatewayError(error.message, 'invalid_request', 400);
  if (error instanceof Anthropic.APIConnectionError) return new AiGatewayError(error.message, 'network', null);
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    return new AiGatewayError(error.message, status === 529 || (status !== null && status >= 500) ? 'overloaded' : 'unknown', status);
  }
  return new AiGatewayError(error instanceof Error ? error.message : String(error), 'unknown', null);
}
