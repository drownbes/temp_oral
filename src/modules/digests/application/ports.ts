import type { FailedSource, TokenUsage } from '../domain/digest.ts';
import type { DigestEntry, ItemAnalysis } from '../domain/digest-entry.ts';
import type { RunId } from '../domain/run-id.ts';

/** An item handed over by the sources context for one run. */
export interface CollectedItem {
  readonly itemId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly text: string;
}

/** Port: reads a collection run's export (the claim check from the sources contract). */
export interface ExportedItemsReader {
  read(exportKey: string): Promise<CollectedItem[]>;
}

export interface AnalysisRequest {
  /** Idempotency key: submitting the same key again returns the existing batch. */
  readonly key: string;
  readonly interests: string;
  /** Text already cut to the configured maximum. */
  readonly items: readonly CollectedItem[];
}

export type BatchState =
  | { readonly state: 'pending' }
  | { readonly state: 'completed' }
  /** Expired or cancelled: whatever finished is usable, the rest is missing. */
  | { readonly state: 'incomplete'; readonly reason: string }
  /** Rejected as a whole (invalid model, malformed input): nothing to use. */
  | { readonly state: 'failed'; readonly reason: string };

export interface AnalysisResults {
  readonly analyses: ReadonlyMap<string, ItemAnalysis>;
  /** Item id → why it has no analysis. Items in neither map were not processed at all. */
  readonly failures: ReadonlyMap<string, string>;
  readonly usage: TokenUsage;
}

/**
 * Port: summarises and scores items asynchronously (an OpenAI Batch in production, which
 * can take up to 24 hours). Prompts and response parsing are the adapter's business.
 */
export interface ItemAnalyzer {
  submit(request: AnalysisRequest): Promise<string>;
  status(batchRef: string): Promise<BatchState>;
  results(batchRef: string): Promise<AnalysisResults>;
}

/** Everything the page shows, already ranked. */
export interface DigestPage {
  readonly runId: RunId;
  readonly generatedAt: Date;
  readonly featured: readonly DigestEntry[];
  readonly alsoNoted: readonly DigestEntry[];
  readonly failedSources: readonly FailedSource[];
  readonly itemCount: number;
  readonly analyzedCount: number;
  readonly failedItemCount: number;
}

/** Port: renders and publishes the digest page (one static HTML object on S3). */
export interface DigestPublisher {
  /** Returns where the page was published. */
  publish(page: DigestPage): Promise<string>;
}

/** Port: starts a digest run asynchronously (a Temporal workflow in production). */
export interface DigestRunStarter {
  start(ownerId: string, runId: RunId): Promise<{ readonly workflowId: string }>;
}
