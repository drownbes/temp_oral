import { describe, expect, it } from 'vitest';
import { addUsage } from '../../domain/digest.ts';
import { DEFAULT_PRICES, priced } from './pricing.ts';

describe('priced', () => {
  const counts = { inputTokens: 2_000_000, outputTokens: 400_000 };
  const price = { input: 0.1, output: 0.5 };

  it('charges half through the Batch API and full price in direct mode', () => {
    // 2M × $0.10 + 0.4M × $0.50 = $0.40 on the normal API
    expect(priced(counts, price, 'direct:digest-1-analysis-abc').costUsd).toBeCloseTo(0.4, 10);
    expect(priced(counts, price, 'batch_6720ab').costUsd).toBeCloseTo(0.2, 10);
  });

  it('leaves the cost unknown for a model without a price, also in totals', () => {
    const unknown = priced(counts, undefined, 'batch_1');
    expect(unknown).toEqual({ ...counts, costUsd: null });
    expect(addUsage(priced(counts, price, 'batch_1'), unknown).costUsd).toBeNull();
  });

  it('knows the default models', () => {
    expect(Object.keys(DEFAULT_PRICES)).toEqual(
      expect.arrayContaining(['gpt-6-luna', 'text-embedding-3-small']),
    );
  });
});
