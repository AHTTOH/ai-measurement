import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { llmGradingOutputSchema, parseGradingText } from './grading-output';
import { mapWithConcurrency, type LlmGrader, type LlmGradingRequest, type LlmGradingResult } from './llm-grader';

/** 구조화 출력 JSON 스키마(SDK가 zod 스키마를 API 형식으로 바꾼 것) */
const OUTPUT_FORMAT = zodOutputFormat(llmGradingOutputSchema);

function toParams(request: LlmGradingRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: request.settings.model,
    max_tokens: request.settings.maxTokens,
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: request.caseBlock, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: request.candidateBlock },
        ],
      },
    ],
    output_config: { effort: request.settings.effort, format: { type: 'json_schema', schema: OUTPUT_FORMAT.schema } },
  };
}

function interpret(request: LlmGradingRequest, message: Anthropic.Message): LlmGradingResult {
  if (message.stop_reason === 'refusal') return { customId: request.customId, ok: false, error: '채점 모델이 응답을 거부했습니다(refusal)' };
  if (message.stop_reason === 'max_tokens') return { customId: request.customId, ok: false, error: '채점 응답이 max_tokens에서 잘렸습니다' };
  const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseGradingText(text, request.items);
  return parsed.ok ? { customId: request.customId, ok: true, output: parsed.output, model: message.model } : { customId: request.customId, ok: false, error: parsed.error };
}

function errorMessage(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `API 오류 ${String(error.status)}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Claude API로 채점한다(공식 SDK 문서의 Messages·Batches 호출 형태).
 * 실제 호출 검증은 API 키 발급 후 한다(결정: AI 모의 게이트웨이).
 */
export class AnthropicGrader implements LlmGrader {
  readonly provider = 'anthropic' as const;
  readonly graderKind = 'llm' as const;

  constructor(private readonly client: Anthropic) {}

  gradeNow(requests: readonly LlmGradingRequest[], concurrency: number): Promise<LlmGradingResult[]> {
    return mapWithConcurrency(requests, concurrency, async (request) => {
      try {
        return interpret(request, await this.client.messages.create(toParams(request)));
      } catch (error) {
        return { customId: request.customId, ok: false, error: errorMessage(error) };
      }
    });
  }

  async submitBatch(requests: readonly LlmGradingRequest[]): Promise<string> {
    const batch = await this.client.messages.batches.create({
      requests: requests.map((r) => ({ custom_id: r.customId, params: toParams(r) })),
    });
    return batch.id;
  }

  async collectBatch(batchId: string, requests: ReadonlyMap<string, LlmGradingRequest>): Promise<LlmGradingResult[] | null> {
    const batch = await this.client.messages.batches.retrieve(batchId);
    if (batch.processing_status !== 'ended') return null;
    const results: LlmGradingResult[] = [];
    for await (const entry of await this.client.messages.batches.results(batchId)) {
      const request = requests.get(entry.custom_id);
      if (request === undefined) throw new Error(`배치 결과에 모르는 custom_id가 있습니다: ${entry.custom_id}`);
      if (entry.result.type === 'succeeded') results.push(interpret(request, entry.result.message));
      else if (entry.result.type === 'errored') results.push({ customId: entry.custom_id, ok: false, error: `배치 요청 오류: ${entry.result.error.error.message}` });
      else results.push({ customId: entry.custom_id, ok: false, error: `배치 요청이 ${entry.result.type} 상태로 끝났습니다` });
    }
    return results;
  }
}
