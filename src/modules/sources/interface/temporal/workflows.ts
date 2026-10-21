// Runs in Temporal's deterministic sandbox: import only @temporalio/workflow, contracts
// and types. dependency-cruiser enforces this.
import { log, proxyActivities } from '@temporalio/workflow';
import type { CollectSourcesWorkflow, FailedSource } from '../../contracts/index.ts';
import type { SourceActivities } from './activities.ts';
import { COLLECT_CONCURRENCY } from './definitions.ts';

const { listCollectableSources, collectSource, exportItems } = proxyActivities<SourceActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds' },
});

const { recordCollectionFailure } = proxyActivities<SourceActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 10, maximumInterval: '1 minute' },
});

/**
 * Implements the published contract; the export name must equal COLLECT_SOURCES_WORKFLOW.
 * Collects every enabled source with bounded concurrency. A source that still fails after
 * its retries is recorded and reported, and never fails the run.
 */
export const collectSourcesWorkflow: CollectSourcesWorkflow = async ({ runId }) => {
  const sourceIds = await listCollectableSources(runId);
  const failedSources: FailedSource[] = [];

  await forEachConcurrent(sourceIds, COLLECT_CONCURRENCY, async (sourceId) => {
    try {
      await collectSource(sourceId, runId);
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
    sources: sourceIds.length,
    failed: failedSources.length,
    itemCount,
  });
  return { runId, exportKey, itemCount, failedSources };
};

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
  return cause instanceof Error ? cause.message : String(cause);
}
