import type { Clock } from '#shared/kernel/clock.ts';
import { clusterEntries } from '../domain/clustering.ts';
import { addUsage, type Digest, type DigestId, NO_USAGE } from '../domain/digest.ts';
import type { DigestEntry } from '../domain/digest-entry.ts';
import { type EarlierCoverageThresholds, markEarlierCoverage } from '../domain/earlier-coverage.ts';
import {
  DigestNotFoundError,
  EnrichmentFailedError,
  InvalidDigestStateError,
} from '../domain/errors.ts';
import type {
  DigestEntryRepository,
  DigestRepository,
  InterestProfileRepository,
} from '../domain/repositories.ts';
import { daysBefore } from '../domain/run-id.ts';
import { batchKey } from './batch-key.ts';
import { type DigestState, toState } from './digest-state.ts';
import type {
  AnalysisResults,
  BatchState,
  CollectedItem,
  EmbeddingResults,
  ExportedItemsReader,
  ItemAnalyzer,
  ItemEmbedder,
} from './ports.ts';
import { forAnalysis } from './submit-enrichment.ts';

export interface IngestEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly profiles: InterestProfileRepository;
  readonly reader: ExportedItemsReader;
  readonly analyzer: ItemAnalyzer;
  readonly embedder: ItemEmbedder;
  readonly clock: Clock;
  /** Article text beyond this is not sent to the LLM (for the reanalysis batch). */
  readonly maxItemChars: number;
  /** Cosine similarity at which two items count as the same story. */
  readonly clusterThreshold: number;
  /** Which earlier digests a story is compared with, and how close counts as seen before. */
  readonly earlierCoverage: EarlierCoverageSettings;
}

export interface EarlierCoverageSettings extends EarlierCoverageThresholds {
  /** How many days back to look. */
  readonly days: number;
}

const NO_EMBEDDINGS: EmbeddingResults = {
  embeddings: new Map(),
  usage: NO_USAGE,
};

/** Analyses of both analysis batches, the second (reanalysis) winning where it answered. */
interface MergedAnalysis {
  readonly results: AnalysisResults;
  /** Why an item has no analysis when its batch neither answered nor failed it. */
  readonly notProcessed: (itemId: string) => string;
}

/**
 * Turns the enrichment batches into digest entries, groups them into stories and marks the
 * stories earlier digests already showed. Items the analysis batch could not analyse (error
 * lines, or left out of an expired batch) first get one reanalysis batch; the digest stays
 * `enriching` until it is done, and this runs again. Every collected item gets an entry,
 * analysed or not, so a partly failed batch still yields a complete page. Embeddings only
 * drive grouping and recognising earlier stories: if their batch failed, every item is its
 * own, new story. Idempotent (entries upsert; batches are keyed by content).
 */
export class IngestEnrichment {
  readonly #deps: IngestEnrichmentDeps;

  constructor(deps: IngestEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, entries, reader, embedder, clock, clusterThreshold } = this.#deps;
    const { earlierCoverage } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, analysisBatchRef, embeddingBatchRef, exportKey, ownerId, runId } =
      digest.toSnapshot();
    if (status !== 'enriching') return toState(digest);
    if (!analysisBatchRef || !embeddingBatchRef || !exportKey) {
      throw new InvalidDigestStateError(`digest ${digestId} has no enrichment batches to ingest`);
    }

    const embeddingState = await embedder.status(embeddingBatchRef);
    if (embeddingState.state === 'pending') {
      throw new InvalidDigestStateError(`enrichment of digest ${digestId} is still running`);
    }
    const analysis = await this.#analysis(digest);
    const collected = await reader.read(exportKey);

    // One more try for what the first batch could not analyse
    const unanalysed = collected.filter((item) => !analysis.results.analyses.has(item.itemId));
    if (unanalysed.length > 0 && !digest.toSnapshot().reanalysisBatchRef) {
      await this.#submitReanalysis(digest, unanalysed);
      return toState(digest);
    }

    const embedding =
      embeddingState.state === 'failed' ? NO_EMBEDDINGS : await embedder.results(embeddingBatchRef);
    const { analyses, failures } = analysis.results;
    const digestEntries = collected.map(
      (item): DigestEntry => ({
        digestId,
        itemId: item.itemId,
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        url: item.url,
        title: item.title,
        publishedAt: item.publishedAt,
        analysis: analyses.get(item.itemId) ?? null,
        failure: analyses.has(item.itemId)
          ? null
          : (failures.get(item.itemId) ?? analysis.notProcessed(item.itemId)),
        embedding: embedding.embeddings.get(item.itemId) ?? null,
      }),
    );
    await entries.saveAll(digestEntries);

    const shown = await entries.listPublished(
      ownerId,
      daysBefore(runId, earlierCoverage.days),
      runId,
    );
    const clusters = markEarlierCoverage(
      clusterEntries(digestEntries, clusterThreshold),
      digestEntries,
      shown,
      earlierCoverage,
    );

    const analyzedCount = digestEntries.filter((e) => e.analysis).length;
    digest.completeEnrichment(
      {
        analyzedCount,
        failedItemCount: digestEntries.length - analyzedCount,
        clusters,
        usage: addUsage(analysis.results.usage, embedding.usage),
      },
      clock.now(),
    );
    await digests.save(digest);
    return toState(digest);
  }

  /**
   * Results of the analysis batch, overlaid with the reanalysis batch's where there is one.
   * A rejected first batch fails the digest; a rejected reanalysis just leaves its items
   * as they were.
   */
  async #analysis(digest: Digest): Promise<MergedAnalysis> {
    const { analyzer } = this.#deps;
    const { id, analysisBatchRef, reanalysisBatchRef } = digest.toSnapshot();
    if (!analysisBatchRef) throw new InvalidDigestStateError(`digest ${id} has no analysis`);

    const [first, second] = await Promise.all([
      analyzer.status(analysisBatchRef),
      reanalysisBatchRef ? analyzer.status(reanalysisBatchRef) : null,
    ]);
    if (first.state === 'pending' || second?.state === 'pending') {
      throw new InvalidDigestStateError(`enrichment of digest ${id} is still running`);
    }
    if (first.state === 'failed') {
      throw new EnrichmentFailedError(`analysis batch ${analysisBatchRef} failed: ${first.reason}`);
    }

    const results = await analyzer.results(analysisBatchRef);
    const firstMissing = missingReason(first);
    if (!reanalysisBatchRef || !second || second.state === 'failed') {
      return { results, notProcessed: () => firstMissing };
    }

    const retried = await analyzer.results(reanalysisBatchRef);
    const failures = new Map(results.failures);
    for (const [itemId, reason] of retried.failures) failures.set(itemId, reason);
    for (const itemId of retried.analyses.keys()) failures.delete(itemId);
    // Every item still without an answer was in the reanalysis, so its reason applies
    const secondMissing = missingReason(second);
    return {
      results: {
        analyses: new Map([...results.analyses, ...retried.analyses]),
        failures,
        usage: addUsage(results.usage, retried.usage),
      },
      notProcessed: () => secondMissing,
    };
  }

  async #submitReanalysis(digest: Digest, unanalysed: readonly CollectedItem[]): Promise<void> {
    const { digests, profiles, analyzer, clock, maxItemChars } = this.#deps;
    const { id, ownerId } = digest.toSnapshot();
    const items = forAnalysis(unanalysed, maxItemChars);
    const interests = (await profiles.find(ownerId))?.toSnapshot().interests ?? '';
    const ref = await analyzer.submit({
      key: await batchKey(id, 'reanalysis', { interests, items }),
      interests,
      items,
    });
    digest.reanalysisSubmitted(ref, clock.now());
    await digests.save(digest);
  }
}

function missingReason(state: BatchState): string {
  return state.state === 'incomplete' ? state.reason : 'missing from batch output';
}
