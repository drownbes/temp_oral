/**
 * Published language of the sources context. Other contexts may import ONLY this file
 * (enforced by dependency-cruiser): plain constants and types, no implementation.
 *
 * A digest starts a collection run by workflow name on the sources task queue. The run's
 * items are too big for workflow history, so they are handed over as a claim check: a JSONL
 * file in the shared bucket (one ExportedItem per line) whose key is in the result.
 */
export const SOURCES_TASK_QUEUE = 'sources';
export const COLLECT_SOURCES_WORKFLOW = 'collectSourcesWorkflow';

export interface CollectSourcesInput {
  /** The day being collected, `YYYY-MM-DD`. Same run id => same items, same export. */
  readonly runId: string;
}

export interface FailedSource {
  readonly sourceId: string;
  readonly reason: string;
}

export interface CollectSourcesResult {
  readonly runId: string;
  /** S3 key (in the shared bucket) of the JSONL export; read-only for consumers. */
  readonly exportKey: string;
  readonly itemCount: number;
  /** Sources that could not be collected; the run still succeeds without them. */
  readonly failedSources: readonly FailedSource[];
}

/** One line of the export file. */
export interface ExportedItem {
  /** Stable across runs: the same article of the same source always has the same id. */
  readonly itemId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  /** 'change': a watched page changed; the text describes what was added and removed. */
  readonly kind: 'article' | 'change';
  readonly url: string;
  readonly title: string;
  /** ISO 8601, when the source states it. */
  readonly publishedAt: string | null;
  /** Readable plain text, untruncated. */
  readonly text: string;
}

export type CollectSourcesWorkflow = (input: CollectSourcesInput) => Promise<CollectSourcesResult>;
