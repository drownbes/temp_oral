import type { TokenUsage } from '../../domain/digest.ts';
import { DIRECT_REF_PREFIX } from './openai-direct-client.ts';

/** USD per million tokens on the normal API; the Batch API charges half. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

/**
 * Prices of the default models (October 2026). They change: override or add models with
 * OPENAI_PRICES, e.g. {"gpt-6-luna":{"input":0.1,"output":0.5}}.
 */
export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
};

const BATCH_DISCOUNT = 0.5;

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What `counts` cost for a batch ref (direct refs pay full price); null for unknown models. */
export function priced(
  counts: TokenCounts,
  price: ModelPrice | undefined,
  batchRef: string,
): TokenUsage {
  if (!price) return { ...counts, costUsd: null };
  const factor = batchRef.startsWith(DIRECT_REF_PREFIX) ? 1 : BATCH_DISCOUNT;
  const costUsd =
    ((counts.inputTokens * price.input + counts.outputTokens * price.output) / 1_000_000) * factor;
  return { ...counts, costUsd };
}
