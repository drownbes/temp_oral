import type { Clock } from '#shared/kernel/clock.ts';
import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository, InterestProfileRepository } from '../domain/repositories.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { ExportedItemsReader, ItemAnalyzer, ItemEmbedder } from './ports.ts';

export interface SubmitEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly profiles: InterestProfileRepository;
  readonly reader: ExportedItemsReader;
  readonly analyzer: ItemAnalyzer;
  readonly embedder: ItemEmbedder;
  readonly clock: Clock;
  /** Article text beyond this is not sent to the LLM. */
  readonly maxItemChars: number;
}

/**
 * Sends the run's items for analysis and for embedding, as two batches running in
 * parallel. Idempotent twice over: a digest with batches is left alone, and each batch is
 * keyed by digest, so a crash before saving finds the same batches instead of paying twice.
 */
export class SubmitEnrichment {
  readonly #deps: SubmitEnrichmentDeps;

  constructor(deps: SubmitEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, profiles, reader, analyzer, embedder, clock, maxItemChars } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, analysisBatchRef, exportKey, ownerId } = digest.toSnapshot();
    if (status !== 'enriching' || analysisBatchRef || !exportKey) return toState(digest);

    const items = (await reader.read(exportKey)).map((item) => ({
      ...item,
      text: item.text.length > maxItemChars ? `${item.text.slice(0, maxItemChars)}…` : item.text,
    }));
    const profile = await profiles.find(ownerId);
    const analysisRef = await analyzer.submit({
      key: `digest-${digestId}-analysis`,
      interests: profile?.toSnapshot().interests ?? '',
      items,
    });
    const embeddingRef = await embedder.submit({ key: `digest-${digestId}-embeddings`, items });

    digest.enrichmentSubmitted(
      { analysisBatchRef: analysisRef, embeddingBatchRef: embeddingRef },
      clock.now(),
    );
    await digests.save(digest);
    return toState(digest);
  }
}
