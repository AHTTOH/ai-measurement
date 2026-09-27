import { describe, expect, it } from 'vitest';
import { createAiGateway, MockGateway } from '@ai-measurement/server';
import { AnthropicGateway } from '../../../server/src/modules/ai/anthropic-gateway';

describe('응시용 AI 게이트웨이 생성', () => {
  it('anthropic 설정과 키가 있으면 Anthropic 게이트웨이를 만든다(네트워크 호출 없음)', () => {
    // Act
    const gateway = createAiGateway({ aiProvider: 'anthropic', anthropicApiKey: 'sk-ant-test', mockAiChunkDelayMs: null });

    // Assert
    expect(gateway).toBeInstanceOf(AnthropicGateway);
    expect(gateway.provider).toBe('anthropic');
  });

  it('anthropic 설정인데 키가 없으면 만들지 않는다', () => {
    const create = () => createAiGateway({ aiProvider: 'anthropic', anthropicApiKey: null, mockAiChunkDelayMs: 40 });

    expect(create).toThrow('ANTHROPIC_API_KEY가 없습니다');
  });

  it('mock 설정이면 적힌 지연으로 모의 게이트웨이를 만든다', async () => {
    // Arrange
    const gateway = createAiGateway({ aiProvider: 'mock', anthropicApiKey: null, mockAiChunkDelayMs: 0 });
    const chunks: string[] = [];

    // Act
    const completion = await gateway.streamConversation(
      { model: 'test-model', maxTokens: 100, effort: 'low', systemPrompt: 's', messages: [{ role: 'user', content: '안녕하세요' }] },
      (delta) => chunks.push(delta),
    );

    // Assert
    expect(gateway).toBeInstanceOf(MockGateway);
    expect(gateway.provider).toBe('mock');
    expect(chunks.join('')).toContain('[모의 AI 응답]');
    expect(completion.model).toBe('mock:test-model');
  });

  it('mock 설정인데 지연 값이 없으면 만들지 않는다', () => {
    const create = () => createAiGateway({ aiProvider: 'mock', anthropicApiKey: 'sk-ant-test', mockAiChunkDelayMs: null });

    expect(create).toThrow('MOCK_AI_CHUNK_DELAY_MS가 없습니다');
  });
});
