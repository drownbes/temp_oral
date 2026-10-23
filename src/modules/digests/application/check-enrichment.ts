import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository } from '../domain/repositories.ts';
import type { ItemAnalyzer, ItemEmbedder } from './ports.ts';

export interface CheckEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly analyzer: ItemAnalyzer;
  readonly embedder: ItemEmbedder;
}

/** Polled by the workflow between durable timers: have its batches finished (in any way)? */
export class CheckEnrichment {
  readonly #deps: CheckEnrichmentDeps;

  constructor(deps: CheckEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<{ done: boolean }> {
    const { digests, analyzer, embedder } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, analysisBatchRef, reanalysisBatchRef, embeddingBatchRef } = digest.toSnapshot();
    if (status !== 'enriching' || !analysisBatchRef || !embeddingBatchRef) return { done: true };
    const states = await Promise.all([
      analyzer.status(analysisBatchRef),
      embedder.status(embeddingBatchRef),
      ...(reanalysisBatchRef ? [analyzer.status(reanalysisBatchRef)] : []),
    ]);
    return { done: states.every((s) => s.state !== 'pending') };
  }
}
