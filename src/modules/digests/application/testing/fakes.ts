import { Digest, type DigestId, type DigestSnapshot } from '../../domain/digest.ts';
import type { DigestEntry, ItemAnalysis } from '../../domain/digest-entry.ts';
import { InterestProfile, type InterestProfileSnapshot } from '../../domain/interest-profile.ts';
import type {
  DigestEntryRepository,
  DigestRepository,
  InterestProfileRepository,
} from '../../domain/repositories.ts';
import type { RunId } from '../../domain/run-id.ts';
import type { StoryText } from '../../domain/story.ts';
import type {
  AnalysisRequest,
  AnalysisResults,
  BatchState,
  CollectedItem,
  DigestPage,
  DigestPublisher,
  DigestRunStarter,
  DigestSynthesizer,
  EmbeddingRequest,
  EmbeddingResults,
  ExportedItemsReader,
  ItemAnalyzer,
  ItemEmbedder,
  SynthesisRequest,
  SynthesisResults,
} from '../ports.ts';

/** In-memory adapters for testing use cases without infrastructure. */
export class InMemoryDigestRepository implements DigestRepository {
  readonly rows = new Map<DigestId, DigestSnapshot>();

  async findById(id: DigestId): Promise<Digest | undefined> {
    const row = this.rows.get(id);
    return row && Digest.restore(row);
  }

  async findByRun(ownerId: string, runId: RunId): Promise<Digest | undefined> {
    const row = [...this.rows.values()].find((d) => d.ownerId === ownerId && d.runId === runId);
    return row && Digest.restore(row);
  }

  async listRecent(ownerId: string, limit: number): Promise<Digest[]> {
    return [...this.rows.values()]
      .filter((d) => d.ownerId === ownerId)
      .sort((a, b) => b.runId.localeCompare(a.runId))
      .slice(0, limit)
      .map((d) => Digest.restore(d));
  }

  async latestPublishedRunId(ownerId: string): Promise<RunId | undefined> {
    return [...this.rows.values()]
      .filter((d) => d.ownerId === ownerId && d.status === 'published')
      .map((d) => d.runId)
      .sort()
      .at(-1);
  }

  async save(digest: Digest): Promise<void> {
    this.rows.set(digest.id, digest.toSnapshot());
  }
}

export class InMemoryDigestEntryRepository implements DigestEntryRepository {
  readonly rows = new Map<string, DigestEntry>();

  async saveAll(entries: readonly DigestEntry[]): Promise<void> {
    for (const entry of entries) this.rows.set(`${entry.digestId}/${entry.itemId}`, entry);
  }

  async listByDigest(digestId: DigestId): Promise<DigestEntry[]> {
    return [...this.rows.values()].filter((e) => e.digestId === digestId);
  }
}

export class InMemoryInterestProfileRepository implements InterestProfileRepository {
  readonly rows = new Map<string, InterestProfileSnapshot>();

  async find(ownerId: string): Promise<InterestProfile | undefined> {
    const row = this.rows.get(ownerId);
    return row && InterestProfile.restore(row);
  }

  async save(profile: InterestProfile): Promise<void> {
    const snapshot = profile.toSnapshot();
    this.rows.set(snapshot.ownerId, snapshot);
  }
}

export class InMemoryExportedItemsReader implements ExportedItemsReader {
  readonly exports = new Map<string, CollectedItem[]>();

  async read(exportKey: string): Promise<CollectedItem[]> {
    const items = this.exports.get(exportKey);
    if (!items) throw new Error(`no export ${exportKey}`);
    return items;
  }
}

/**
 * Batches stay pending until `finish` is called. Every item gets an analysis whose relevance
 * is taken from `relevance` (default 0.8), unless listed in `failures`.
 */
export class FakeItemAnalyzer implements ItemAnalyzer {
  readonly submitted: AnalysisRequest[] = [];
  readonly batches = new Map<string, { request: AnalysisRequest; state: BatchState }>();
  readonly relevance = new Map<string, number>();
  readonly failures = new Map<string, string>();

  async submit(request: AnalysisRequest): Promise<string> {
    const ref = `batch-${request.key}`;
    if (!this.batches.has(ref)) {
      this.submitted.push(request);
      this.batches.set(ref, { request, state: { state: 'pending' } });
    }
    return ref;
  }

  finish(ref: string, state: BatchState = { state: 'completed' }): void {
    const batch = this.batches.get(ref);
    if (!batch) throw new Error(`no batch ${ref}`);
    batch.state = state;
  }

  async status(ref: string): Promise<BatchState> {
    const batch = this.batches.get(ref);
    if (!batch) throw new Error(`no batch ${ref}`);
    return batch.state;
  }

  async results(ref: string): Promise<AnalysisResults> {
    const batch = this.batches.get(ref);
    if (!batch) throw new Error(`no batch ${ref}`);
    const analyses = new Map<string, ItemAnalysis>();
    const failures = new Map<string, string>();
    // An incomplete batch only processed its first item
    const processed =
      batch.state.state === 'incomplete' ? batch.request.items.slice(0, 1) : batch.request.items;
    for (const item of processed) {
      const failure = this.failures.get(item.itemId);
      if (failure) failures.set(item.itemId, failure);
      else {
        analyses.set(item.itemId, {
          summary: `Summary of ${item.title}`,
          relevance: this.relevance.get(item.itemId) ?? 0.8,
          reason: 'fake',
          tags: [],
        });
      }
    }
    return { analyses, failures, usage: { inputTokens: 100 * processed.length, outputTokens: 10 } };
  }
}

/** Fake batches: pending until `finish`, keyed like the real ones (`batch-<key>`). */
class FakeBatches<R> {
  readonly submitted: R[] = [];
  readonly batches = new Map<string, { request: R; state: BatchState }>();

  submit(key: string, request: R): string {
    const ref = `batch-${key}`;
    if (!this.batches.has(ref)) {
      this.submitted.push(request);
      this.batches.set(ref, { request, state: { state: 'pending' } });
    }
    return ref;
  }

  get(ref: string) {
    const batch = this.batches.get(ref);
    if (!batch) throw new Error(`no batch ${ref}`);
    return batch;
  }

  /** Finishes every batch whose key contains `keyPart`. */
  finish(keyPart: string, state: BatchState = { state: 'completed' }): void {
    for (const [ref, batch] of this.batches) if (ref.includes(keyPart)) batch.state = state;
  }
}

/**
 * Items get the vector set in `vectors`, or a vector of their own (orthogonal to all
 * others), so by default nothing clusters.
 */
export class FakeItemEmbedder implements ItemEmbedder {
  readonly fake = new FakeBatches<EmbeddingRequest>();
  readonly vectors = new Map<string, number[]>();

  async submit(request: EmbeddingRequest): Promise<string> {
    return this.fake.submit(request.key, request);
  }

  async status(ref: string): Promise<BatchState> {
    return this.fake.get(ref).state;
  }

  async results(ref: string): Promise<EmbeddingResults> {
    const { request } = this.fake.get(ref);
    const embeddings = new Map<string, readonly number[]>();
    request.items.forEach((item, i) => {
      const unique = Array.from({ length: request.items.length }, (_, j) => (i === j ? 1 : 0));
      embeddings.set(item.itemId, this.vectors.get(item.itemId) ?? unique);
    });
    return { embeddings, usage: { inputTokens: 5 * request.items.length, outputTokens: 0 } };
  }
}

/** Merged headline "Merged: <first title>", overview listing the highlight titles. */
export class FakeDigestSynthesizer implements DigestSynthesizer {
  readonly fake = new FakeBatches<SynthesisRequest>();

  async submit(request: SynthesisRequest): Promise<string> {
    return this.fake.submit(request.key, request);
  }

  async status(ref: string): Promise<BatchState> {
    return this.fake.get(ref).state;
  }

  async results(ref: string): Promise<SynthesisResults> {
    const { request } = this.fake.get(ref);
    const stories = new Map<string, StoryText>();
    for (const story of request.stories) {
      stories.set(story.clusterId, {
        headline: `Merged: ${story.items[0]?.title}`,
        summary: story.items.map((i) => i.sourceName).join(' + '),
      });
    }
    const overview = request.highlights.length
      ? `Overview of ${request.highlights.map((h) => h.title).join(', ')}`
      : null;
    return { stories, overview, usage: { inputTokens: 50, outputTokens: 20 } };
  }
}

export class RecordingPublisher implements DigestPublisher {
  readonly pages: DigestPage[] = [];

  async publish(page: DigestPage): Promise<string> {
    this.pages.push(page);
    return 'memory://latest';
  }
}

export class RecordingDigestRunStarter implements DigestRunStarter {
  readonly started: { ownerId: string; runId: RunId }[] = [];

  async start(ownerId: string, runId: RunId): Promise<{ workflowId: string }> {
    this.started.push({ ownerId, runId });
    return { workflowId: `digest-${ownerId}-${runId}` };
  }
}

export function mutableClock(iso = '2026-10-21T06:00:00Z') {
  let now = new Date(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next);
    },
  };
}
