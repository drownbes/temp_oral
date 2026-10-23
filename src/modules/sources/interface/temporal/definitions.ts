/** Temporal wiring internal to the sources context; the public part is in contracts/. */
import type { CollectSourcesInput } from '../../contracts/index.ts';

/** How many sources one run fetches at the same time. */
export const COLLECT_CONCURRENCY = 4;

export const collectSourcesWorkflowId = (runId: string) => `collect-sources-${runId}`;

/**
 * Served only by workers with BROWSER_FETCH_ENABLED: collecting and previewing browser
 * sources. Internal, because only this context's own workflows put work on it.
 */
export const SOURCES_BROWSER_TASK_QUEUE = 'sources-browser';
export const PREVIEW_SOURCE_WORKFLOW = 'previewSourceWorkflow';

/**
 * How long a browser source waits for a browser worker to pick it up. Past this, no browser
 * worker is running, and the source is reported as failed instead of holding up the run.
 */
export const BROWSER_PICKUP_TIMEOUT = '15 minutes';
/** A preview is waited for by an HTTP request, so it gives up much sooner. */
export const BROWSER_PREVIEW_PICKUP_TIMEOUT = '20 seconds';
/** Failure type of a preview that no browser worker picked up. */
export const BROWSER_UNAVAILABLE = 'BROWSER_UNAVAILABLE';

export interface CollectSourcesRunInput extends CollectSourcesInput {
  /** Override of BROWSER_PICKUP_TIMEOUT, for tests. */
  readonly browserPickupTimeout?: string;
}
