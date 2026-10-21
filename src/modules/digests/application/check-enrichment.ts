import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository } from '../domain/repositories.ts';
import type { ItemAnalyzer, ItemEmbedder } from './ports.ts';

export interface CheckEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly analyzer: ItemAnalyzer;
  readonly embedder: ItemEmbedder;
}

/** Polled by the workflow between durable timers: have both batches finished (in any way)? */
export class CheckEnrichment {
  readonly #deps: CheckEnrichmentDeps;

  constructor(deps: CheckEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<{ done: boolean }> {
    const { digests, analyzer, embedder } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, analysisBatchRef, embeddingBatchRef } = digest.toSnapshot();
    if (status !== 'enriching' || !analysisBatchRef || !embeddingBatchRef) return { done: true };
    const [analysis, embeddings] = await Promise.all([
      analyzer.status(analysisBatchRef),
      embedder.status(embeddingBatchRef),
    ]);
    return { done: analysis.state !== 'pending' && embeddings.state !== 'pending' };
  }
}
