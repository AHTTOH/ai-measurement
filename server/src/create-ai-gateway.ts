import Anthropic from '@anthropic-ai/sdk';
import type { CandidateServerConfig } from './config/candidate-server-config';
import type { AiGateway } from './modules/ai/ai-gateway';
import { AnthropicGateway } from './modules/ai/anthropic-gateway';
import { MockGateway } from './modules/ai/mock-gateway';

export type AiGatewaySettings = Pick<CandidateServerConfig, 'aiProvider' | 'anthropicApiKey' | 'mockAiChunkDelayMs'>;

/** 설정에 적힌 공급자로 응시용 AI 게이트웨이를 만든다. 설정 검증에서 필수값을 이미 확인했다 */
export function createAiGateway(config: AiGatewaySettings): AiGateway {
  if (config.aiProvider === 'anthropic') {
    if (config.anthropicApiKey === null) throw new Error('ANTHROPIC_API_KEY가 없습니다');
    return new AnthropicGateway(new Anthropic({ apiKey: config.anthropicApiKey }));
  }
  if (config.mockAiChunkDelayMs === null) throw new Error('MOCK_AI_CHUNK_DELAY_MS가 없습니다');
  return new MockGateway({ chunkDelayMs: config.mockAiChunkDelayMs });
}
