import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository } from '../domain/repositories.ts';
import type { ItemAnalyzer } from './ports.ts';

export interface CheckEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly analyzer: ItemAnalyzer;
}

/** Polled by the workflow between durable timers: is the batch finished (in any way)? */
export class CheckEnrichment {
  readonly #deps: CheckEnrichmentDeps;

  constructor(deps: CheckEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<{ done: boolean }> {
    const digest = await this.#deps.digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, batchRef } = digest.toSnapshot();
    if (status !== 'enriching' || !batchRef) return { done: true };
    const batch = await this.#deps.analyzer.status(batchRef);
    return { done: batch.state !== 'pending' };
  }
}
