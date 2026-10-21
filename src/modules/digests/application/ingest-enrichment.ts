import type { Clock } from '#shared/kernel/clock.ts';
import type { DigestId } from '../domain/digest.ts';
import type { DigestEntry } from '../domain/digest-entry.ts';
import {
  DigestNotFoundError,
  EnrichmentFailedError,
  InvalidDigestStateError,
} from '../domain/errors.ts';
import type { DigestEntryRepository, DigestRepository } from '../domain/repositories.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { ExportedItemsReader, ItemAnalyzer } from './ports.ts';

export interface IngestEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly reader: ExportedItemsReader;
  readonly analyzer: ItemAnalyzer;
  readonly clock: Clock;
}

/**
 * Turns batch results into digest entries: every collected item gets an entry, analysed or
 * not, so a partly failed batch still yields a complete page. Idempotent (entries upsert).
 */
export class IngestEnrichment {
  readonly #deps: IngestEnrichmentDeps;

  constructor(deps: IngestEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, entries, reader, analyzer, clock } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, batchRef, exportKey } = digest.toSnapshot();
    if (status !== 'enriching') return toState(digest);
    if (!batchRef || !exportKey) {
      throw new InvalidDigestStateError(`digest ${digestId} has no enrichment batch to ingest`);
    }

    const batch = await analyzer.status(batchRef);
    if (batch.state === 'pending') {
      throw new InvalidDigestStateError(`batch ${batchRef} of digest ${digestId} is still running`);
    }
    if (batch.state === 'failed') {
      throw new EnrichmentFailedError(`batch ${batchRef} failed: ${batch.reason}`);
    }

    const results = await analyzer.results(batchRef);
    const notProcessed = batch.state === 'incomplete' ? batch.reason : 'missing from batch output';
    const collected = await reader.read(exportKey);
    const digestEntries = collected.map(
      (item): DigestEntry => ({
        digestId,
        itemId: item.itemId,
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        url: item.url,
        title: item.title,
        publishedAt: item.publishedAt,
        analysis: results.analyses.get(item.itemId) ?? null,
        failure: results.analyses.has(item.itemId)
          ? null
          : (results.failures.get(item.itemId) ?? notProcessed),
      }),
    );
    await entries.saveAll(digestEntries);

    const analyzedCount = digestEntries.filter((e) => e.analysis).length;
    digest.completeEnrichment(
      {
        analyzedCount,
        failedItemCount: digestEntries.length - analyzedCount,
        usage: results.usage,
      },
      clock.now(),
    );
    await digests.save(digest);
    return toState(digest);
  }
}
