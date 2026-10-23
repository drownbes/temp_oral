import type {
  AnalysisRequest,
  AnalysisResults,
  BatchState,
  ItemAnalyzer,
} from '../../application/ports.ts';
import { NO_USAGE } from '../../domain/digest.ts';
import type { ItemAnalysis } from '../../domain/digest-entry.ts';

/**
 * Development stand-in for the LLM (LLM_PROVIDER=stub): completes instantly with a
 * "summary" made of the first sentences and a pseudo-random but stable relevance.
 * Batches live in memory, so a worker restart between submit and ingest loses them.
 */
export class StubItemAnalyzer implements ItemAnalyzer {
  readonly #batches = new Map<string, AnalysisRequest>();

  async submit(request: AnalysisRequest): Promise<string> {
    const ref = `stub-${request.key}`;
    this.#batches.set(ref, request);
    return ref;
  }

  async status(): Promise<BatchState> {
    return { state: 'completed' };
  }

  async results(batchRef: string): Promise<AnalysisResults> {
    const request = this.#batches.get(batchRef);
    const analyses = new Map<string, ItemAnalysis>();
    for (const item of request?.items ?? []) {
      // A sentence ends at punctuation followed by whitespace, so "Linux 7.3" stays whole
      const sentences = item.text
        .split(/(?<=[.!?])\s+/)
        .slice(0, 2)
        .join(' ');
      analyses.set(item.itemId, {
        summary: `[stub] ${sentences.trim().slice(0, 400) || item.title}`,
        relevance: stableFraction(item.itemId),
        reason: 'stub analyzer: relevance is random',
        tags: ['stub'],
      });
    }
    return { analyses, failures: new Map(), usage: NO_USAGE };
  }
}

function stableFraction(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return Math.round(((hash % 1000) / 1000) * 100) / 100;
}
