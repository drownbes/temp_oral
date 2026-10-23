// Runs in Temporal's deterministic sandbox: import only @temporalio/workflow, contracts
// and types. dependency-cruiser enforces this.
import { ApplicationFailure, log, proxyActivities, TimeoutFailure } from '@temporalio/workflow';
import type { PreviewSourceCommand, SourcePreview } from '../../application/preview-source.ts';
import type { CollectSourcesWorkflow, FailedSource } from '../../contracts/index.ts';
import type { FetchMode } from '../../domain/source.ts';
import type { BrowserActivities, SourceActivities } from './activities.ts';
import {
  BROWSER_PICKUP_TIMEOUT,
  BROWSER_PREVIEW_PICKUP_TIMEOUT,
  BROWSER_UNAVAILABLE,
  COLLECT_CONCURRENCY,
  type CollectSourcesRunInput,
  SOURCES_BROWSER_TASK_QUEUE,
} from './definitions.ts';

const { listCollectableSources, exportItems } = proxyActivities<SourceActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds' },
});

// Fetching a feed plus up to 30 article pages (2 at a time) can take a few minutes
const COLLECT_OPTIONS = {
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds' },
} as const;
const { collectSource } = proxyActivities<SourceActivities>(COLLECT_OPTIONS);

const { recordCollectionFailure } = proxyActivities<SourceActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 10, maximumInterval: '1 minute' },
});

// Someone is waiting for the answer: one attempt, and a quick error without a browser worker
const { previewSource } = proxyActivities<BrowserActivities>({
  taskQueue: SOURCES_BROWSER_TASK_QUEUE,
  scheduleToStartTimeout: BROWSER_PREVIEW_PICKUP_TIMEOUT,
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

/**
 * Implements the published CollectSourcesWorkflow contract; the export name must equal
 * COLLECT_SOURCES_WORKFLOW. Collects every enabled source with bounded concurrency; browser
 * sources go to the browser worker's queue. A source that still fails after its retries is
 * recorded and reported, and never fails the run.
 */
export const collectSourcesWorkflow: CollectSourcesWorkflow = async ({
  runId,
  browserPickupTimeout,
}: CollectSourcesRunInput) => {
  const sources = await listCollectableSources(runId);
  const failedSources: FailedSource[] = [];
  const browser = proxyActivities<BrowserActivities>({
    ...COLLECT_OPTIONS,
    taskQueue: SOURCES_BROWSER_TASK_QUEUE,
    scheduleToStartTimeout: browserPickupTimeout ?? BROWSER_PICKUP_TIMEOUT,
  });
  const collectors: Record<FetchMode, BrowserActivities['collectSource']> = {
    http: collectSource,
    browser: browser.collectSource,
  };

  await forEachConcurrent(sources, COLLECT_CONCURRENCY, async ({ sourceId, fetchMode }) => {
    try {
      await collectors[fetchMode](sourceId, runId);
    } catch (err) {
      const reason = failureReason(err);
      log.warn('source collection failed', { sourceId, runId, reason });
      await recordCollectionFailure(sourceId, reason);
      failedSources.push({ sourceId, reason });
    }
  });

  const { exportKey, itemCount } = await exportItems(runId);
  log.info('sources collected', {
    runId,
    sources: sources.length,
    failed: failedSources.length,
    itemCount,
  });
  return { runId, exportKey, itemCount, failedSources };
};

/**
 * Previews a browser source for the API, which has no browser itself. Runs on the sources
 * queue, so it fails quickly when no browser worker is there to take the activity. Fails
 * with the activity's error type (BROWSER_UNAVAILABLE without a browser worker).
 */
export async function previewSourceWorkflow(command: PreviewSourceCommand): Promise<SourcePreview> {
  try {
    return await previewSource(command);
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    const type = isPickupTimeout(cause)
      ? BROWSER_UNAVAILABLE
      : cause instanceof ApplicationFailure
        ? cause.type
        : undefined;
    throw ApplicationFailure.nonRetryable(failureReason(err), type ?? 'BROWSER_PREVIEW_FAILED');
  }
}

/** A pool rather than fixed batches, so one slow source doesn't hold back the others. */
async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** ActivityFailure wraps the activity's own error; report that one. */
function failureReason(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  if (isPickupTimeout(cause)) {
    return 'no browser worker took the page (is a worker running with BROWSER_FETCH_ENABLED=true?)';
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** Nobody served the queue in time: for browser activities, no browser worker is running. */
function isPickupTimeout(err: unknown): boolean {
  return err instanceof TimeoutFailure && err.timeoutType === 'SCHEDULE_TO_START';
}
