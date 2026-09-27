import type Anthropic from '@anthropic-ai/sdk';
import type { ApiUsageRecord } from '@ai-measurement/infra';
import type { AiProviderName, EffortLevel } from '@ai-measurement/shared';

/**
 * 응시용 AI 호출 경계. 실제 구현(Anthropic)과 모의 구현(mock)을 설정으로 고른다.
 * 모의 구현은 AI_PROVIDER=mock을 명시했을 때만 쓴다(결정: AI 모의 게이트웨이).
 */

export interface AiCountRequest {
  model: string;
  /** null이면 시스템 프롬프트 없이 센다(신규 전송분만 셀 때) */
  systemPrompt: string | null;
  messages: Anthropic.MessageParam[];
}

export interface AiConversationRequest {
  model: string;
  maxTokens: number;
  effort: EffortLevel;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
}

export interface AiCompletion {
  providerMessageId: string;
  model: string;
  /** API가 돌려준 content 블록 그대로. 다음 요청에 바꾸지 않고 다시 보낸다 */
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: ApiUsageRecord;
  requestId: string | null;
}

export type AiFailureKind = 'rate_limited' | 'overloaded' | 'invalid_request' | 'auth' | 'network' | 'unknown';

export class AiGatewayError extends Error {
  override readonly name = 'AiGatewayError';

  constructor(
    message: string,
    readonly kind: AiFailureKind,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface AiGateway {
  readonly provider: AiProviderName;
  countTokens(request: AiCountRequest): Promise<number>;
  streamConversation(request: AiConversationRequest, onText: (delta: string) => void): Promise<AiCompletion>;
}

/** 응시자에게 보여줄 실패 안내 */
export const AI_FAILURE_MESSAGES: Readonly<Record<AiFailureKind, string>> = {
  rate_limited: 'AI 요청이 몰려 처리하지 못했습니다. 잠시 후 다시 보내십시오. 차감된 토큰은 감독관에게 알리십시오.',
  overloaded: 'AI 서비스가 일시적으로 혼잡합니다. 잠시 후 다시 보내십시오. 차감된 토큰은 감독관에게 알리십시오.',
  invalid_request: 'AI가 요청을 처리하지 못했습니다. 첨부나 본문을 줄여 다시 보내십시오.',
  auth: 'AI 서비스 인증에 실패했습니다. 감독관에게 알리십시오.',
  network: 'AI 서비스에 연결하지 못했습니다. 감독관에게 알리십시오.',
  unknown: 'AI 응답 중 오류가 발생했습니다. 감독관에게 알리십시오.',
};
