import type { GraderSettings } from '@ai-measurement/shared';
import type { LlmGradingOutput, LlmItemsSpec } from './grading-output';

/** Batches custom_id 형식 제한: 영문·숫자·_·- 1~64자 */
export const CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

export interface LlmGradingRequest {
  customId: string;
  system: string;
  /** 같은 Case의 모든 응시자에게 같은 블록(캐시 대상) */
  caseBlock: string;
  candidateBlock: string;
  settings: GraderSettings;
  items: LlmItemsSpec;
}

export type LlmGradingResult =
  | { customId: string; ok: true; output: LlmGradingOutput; model: string }
  | { customId: string; ok: false; error: string };

/**
 * LLM 채점 경계. 실제 구현(Anthropic)과 모의 구현(mock)을 설정으로 고른다(결정: AI 모의 게이트웨이).
 * 즉시 모드는 바로 결과를 받고, 배치 모드는 제출 후 나중에 결과를 모은다(결정 D10).
 */
export interface LlmGrader {
  readonly provider: 'anthropic' | 'mock';
  readonly graderKind: 'llm' | 'llm-mock';
  gradeNow(requests: readonly LlmGradingRequest[], concurrency: number): Promise<LlmGradingResult[]>;
  submitBatch(requests: readonly LlmGradingRequest[]): Promise<string>;
  /** 배치가 끝났으면 결과를, 아직이면 null을 돌려준다 */
  collectBatch(batchId: string, requests: ReadonlyMap<string, LlmGradingRequest>): Promise<LlmGradingResult[] | null>;
}

/** 동시 실행 수를 제한해 순서대로 결과를 모은다 */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
