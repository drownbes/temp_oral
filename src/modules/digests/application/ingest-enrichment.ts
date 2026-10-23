import type { Clock } from '#shared/kernel/clock.ts';
import { clusterEntries } from '../domain/clustering.ts';
import type { DigestId } from '../domain/digest.ts';
import type { DigestEntry } from '../domain/digest-entry.ts';
import { type EarlierCoverageThresholds, markEarlierCoverage } from '../domain/earlier-coverage.ts';
import {
  DigestNotFoundError,
  EnrichmentFailedError,
  InvalidDigestStateError,
} from '../domain/errors.ts';
import type { DigestEntryRepository, DigestRepository } from '../domain/repositories.ts';
import { daysBefore } from '../domain/run-id.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { EmbeddingResults, ExportedItemsReader, ItemAnalyzer, ItemEmbedder } from './ports.ts';

export interface IngestEnrichmentDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly reader: ExportedItemsReader;
  readonly analyzer: ItemAnalyzer;
  readonly embedder: ItemEmbedder;
  readonly clock: Clock;
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
  usage: { inputTokens: 0, outputTokens: 0 },
};

/**
 * Turns both batches into digest entries, groups them into stories and marks the stories
 * earlier digests already showed. Every collected item gets an entry, analysed or not, so a
 * partly failed batch still yields a complete page. Embeddings only drive grouping and
 * recognising earlier stories: if their batch failed, every item is its own, new story.
 * Idempotent (entries upsert; the history is only of earlier days).
 */
export class IngestEnrichment {
  readonly #deps: IngestEnrichmentDeps;

  constructor(deps: IngestEnrichmentDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, entries, reader, analyzer, embedder, clock, clusterThreshold } = this.#deps;
    const { earlierCoverage } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, analysisBatchRef, embeddingBatchRef, exportKey, ownerId, runId } =
      digest.toSnapshot();
    if (status !== 'enriching') return toState(digest);
    if (!analysisBatchRef || !embeddingBatchRef || !exportKey) {
      throw new InvalidDigestStateError(`digest ${digestId} has no enrichment batches to ingest`);
    }

    const [analysisState, embeddingState] = await Promise.all([
      analyzer.status(analysisBatchRef),
      embedder.status(embeddingBatchRef),
    ]);
    if (analysisState.state === 'pending' || embeddingState.state === 'pending') {
      throw new InvalidDigestStateError(`enrichment of digest ${digestId} is still running`);
    }
    if (analysisState.state === 'failed') {
      throw new EnrichmentFailedError(
        `analysis batch ${analysisBatchRef} failed: ${analysisState.reason}`,
      );
    }

    const analysis = await analyzer.results(analysisBatchRef);
    const embedding =
      embeddingState.state === 'failed' ? NO_EMBEDDINGS : await embedder.results(embeddingBatchRef);
    const notProcessed =
      analysisState.state === 'incomplete' ? analysisState.reason : 'missing from batch output';

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
        analysis: analysis.analyses.get(item.itemId) ?? null,
        failure: analysis.analyses.has(item.itemId)
          ? null
          : (analysis.failures.get(item.itemId) ?? notProcessed),
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
        usage: {
          inputTokens: analysis.usage.inputTokens + embedding.usage.inputTokens,
          outputTokens: analysis.usage.outputTokens + embedding.usage.outputTokens,
        },
      },
      clock.now(),
    );
    await digests.save(digest);
    return toState(digest);
  }
}
