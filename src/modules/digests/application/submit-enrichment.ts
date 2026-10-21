import type { Clock } from '#shared/kernel/clock.ts';
import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository, InterestProfileRepository } from '../domain/repositories.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { ExportedItemsReader, ItemAnalyzer } from './ports.ts';

export interface SubmitEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly profiles: InterestProfileRepository;
  readonly reader: ExportedItemsReader;
  readonly analyzer: ItemAnalyzer;
  readonly clock: Clock;
  /** Article text beyond this is not sent to the LLM. */
  readonly maxItemChars: number;
}

/**
 * Sends the run's items for analysis. Idempotent twice over: a digest with a batch is left
 * alone, and the batch is keyed by digest, so a crash between submitting and saving finds
 * the same batch again instead of paying for a second one.
 */
export class SubmitEnrichment {
  readonly #deps: SubmitEnrichmentDeps;

  constructor(deps: SubmitEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, profiles, reader, analyzer, clock, maxItemChars } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, batchRef, exportKey, ownerId } = digest.toSnapshot();
    if (status !== 'enriching' || batchRef || !exportKey) return toState(digest);

    const items = (await reader.read(exportKey)).map((item) => ({
      ...item,
      text: item.text.length > maxItemChars ? `${item.text.slice(0, maxItemChars)}…` : item.text,
    }));
    const profile = await profiles.find(ownerId);
    const ref = await analyzer.submit({
      key: `digest-${digestId}-enrichment`,
      interests: profile?.toSnapshot().interests ?? '',
      items,
    });

    digest.enrichmentSubmitted(ref, clock.now());
    await digests.save(digest);
    return toState(digest);
  }
}
