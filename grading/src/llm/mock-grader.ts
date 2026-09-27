import { randomUUID } from 'node:crypto';
import type { LlmGrader, LlmGradingRequest, LlmGradingResult } from './llm-grader';

export const MOCK_GRADER_RATIONALE = '[모의 채점] 실제 LLM이 아닌 개발용 점수입니다';

/**
 * 개발·테스트용 모의 채점기. 기준마다 배점의 절반을 주고 수치는 찾지 못한 것으로 둔다.
 * 결과는 grader='llm-mock'으로 기록되어 화면에서 모의 채점으로 표시된다.
 */
export class MockGrader implements LlmGrader {
  readonly provider = 'mock' as const;
  readonly graderKind = 'llm-mock' as const;
  private readonly batches = new Map<string, readonly LlmGradingRequest[]>();

  async gradeNow(requests: readonly LlmGradingRequest[]): Promise<LlmGradingResult[]> {
    return requests.map((r) => this.grade(r));
  }

  async submitBatch(requests: readonly LlmGradingRequest[]): Promise<string> {
    const id = `mock_batch_${randomUUID()}`;
    this.batches.set(id, requests);
    return id;
  }

  async collectBatch(batchId: string): Promise<LlmGradingResult[] | null> {
    const requests = this.batches.get(batchId);
    if (requests === undefined) throw new Error(`모의 배치가 없습니다(워커가 다시 시작되면 모의 배치는 사라집니다): ${batchId}`);
    // 실제 배치처럼 결과를 여러 번 받을 수 있게 지우지 않는다(결과 저장 중 멈춘 작업의 재시도용)
    return requests.map((r) => this.grade(r));
  }

  private grade(request: LlmGradingRequest): LlmGradingResult {
    return {
      customId: request.customId,
      ok: true,
      model: `mock:${request.settings.model}`,
      output: {
        criteria: request.items.criteria.map((c) => ({ id: c.id, score: Math.floor(c.points) / 2, rationale: MOCK_GRADER_RATIONALE, evidence: [] })),
        numeric: request.items.numeric.map((n) => ({ id: n.id, reportedValue: null, quote: '' })),
      },
    };
  }
}
