import type { FailedSource, TokenUsage } from '../domain/digest.ts';
import type { ItemAnalysis } from '../domain/digest-entry.ts';
import type { Story } from '../domain/ranking.ts';
import type { RunId } from '../domain/run-id.ts';
import type { StoryText } from '../domain/story.ts';

/** An item handed over by the sources context for one run. */
export interface CollectedItem {
  readonly itemId: string;
  /** 'change': a watched page changed; `text` lists the added and removed lines. */
  readonly kind: 'article' | 'change';
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

export interface EmbeddingRequest {
  /** Idempotency key: submitting the same key again returns the existing batch. */
  readonly key: string;
  readonly items: readonly CollectedItem[];
}

export interface EmbeddingResults {
  readonly embeddings: ReadonlyMap<string, readonly number[]>;
  readonly usage: TokenUsage;
}

/** Port: semantic vectors of items, asynchronously (an OpenAI Batch in production). */
export interface ItemEmbedder {
  submit(request: EmbeddingRequest): Promise<string>;
  status(batchRef: string): Promise<BatchState>;
  results(batchRef: string): Promise<EmbeddingResults>;
}

/** One item of a story, as the synthesizer sees it. */
export interface StoryItem {
  readonly sourceName: string;
  readonly title: string;
  /** The item's summary, or the start of its text when it has none. */
  readonly summary: string;
}

export interface SynthesisRequest {
  /** Idempotency key: submitting the same key again returns the existing batch. */
  readonly key: string;
  readonly interests: string;
  /** Stories covered by several items, to merge into one headline and summary each. */
  readonly stories: readonly { readonly clusterId: string; readonly items: readonly StoryItem[] }[];
  /** The day's most relevant stories, for the overview; empty means no overview. */
  readonly highlights: readonly StoryItem[];
}

export interface SynthesisResults {
  readonly stories: ReadonlyMap<string, StoryText>;
  readonly overview: string | null;
  readonly usage: TokenUsage;
}

/** Port: merges multi-source stories and writes the day's overview (an OpenAI Batch). */
export interface DigestSynthesizer {
  submit(request: SynthesisRequest): Promise<string>;
  status(batchRef: string): Promise<BatchState>;
  results(batchRef: string): Promise<SynthesisResults>;
}

/** Everything the page shows, already grouped and ranked. */
export interface DigestPage {
  readonly runId: RunId;
  readonly generatedAt: Date;
  readonly overview: string | null;
  readonly featured: readonly Story[];
  readonly alsoNoted: readonly Story[];
  /** Already shown by earlier digests: listed in the footer, not repeated. */
  readonly repeated: readonly Story[];
  readonly failedSources: readonly FailedSource[];
  readonly itemCount: number;
  readonly analyzedCount: number;
  readonly failedItemCount: number;
  /** All LLM calls of the digest. */
  readonly usage: TokenUsage;
}

/**
 * Port: renders and publishes the digest page (static HTML on S3). Every day's page is kept
 * in the archive; only the newest day also becomes the "latest" page.
 */
export interface DigestPublisher {
  /** Idempotent: publishing a day again overwrites its pages. Returns where its archived page is. */
  publish(page: DigestPage, options: { readonly latest: boolean }): Promise<string>;
}

/** Port: starts a digest run asynchronously (a Temporal workflow in production). */
export interface DigestRunStarter {
  start(ownerId: string, runId: RunId): Promise<{ readonly workflowId: string }>;
}
