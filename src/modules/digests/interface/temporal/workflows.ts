// Runs in Temporal's deterministic sandbox: import only @temporalio/workflow, contracts
// and types. dependency-cruiser enforces this.
import {
  ApplicationFailure,
  executeChild,
  log,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import {
  COLLECT_SOURCES_WORKFLOW,
  type CollectSourcesWorkflow,
  SOURCES_TASK_QUEUE,
} from '#modules/sources/contracts/index.ts';
import type { DigestState } from '../../application/digest-state.ts';
import type { DigestActivities } from './activities.ts';
import { BATCH_POLL_INTERVALS, type DailyDigestInput, pollDelay } from './definitions.ts';

const {
  beginDigest,
  recordCollection,
  checkEnrichment,
  ingestEnrichment,
  checkSynthesis,
  ingestSynthesis,
  publishDigest,
} = proxyActivities<DigestActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5, initialInterval: '10 seconds' },
});

// Submitting uploads a batch, or in direct mode runs every request right away: allow minutes
const { submitEnrichment, submitSynthesis } = proxyActivities<DigestActivities>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 3, initialInterval: '30 seconds' },
});

const { markDigestFailed } = proxyActivities<DigestActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 10, maximumInterval: '1 minute' },
});

/**
 * One day's digest. Driven by the digest's persisted status, so a re-run of the same day
 * resumes where the previous one stopped (e.g. still waiting for its batch) instead of
 * starting over. The LLM batch can take up to 24h: the wait is a durable timer loop.
 */
export async function dailyDigestWorkflow(input: DailyDigestInput): Promise<DigestState> {
  const info = workflowInfo();
  let state = await beginDigest({
    ownerId: input.ownerId,
    runId: input.runId,
    startedAt: info.startTime.toISOString(),
  });

  try {
    while (state.status !== 'published' && state.status !== 'superseded') {
      switch (state.status) {
        case 'collecting': {
          // Collection is idempotent per run id, so its own workflow id only needs to be
          // unique per digest run (a manual and a scheduled run may overlap)
          const collection = await executeChild<CollectSourcesWorkflow>(COLLECT_SOURCES_WORKFLOW, {
            taskQueue: SOURCES_TASK_QUEUE,
            workflowId: `${info.workflowId}-collect-sources`,
            args: [{ runId: state.runId }],
          });
          state = await recordCollection(state.digestId, {
            exportKey: collection.exportKey,
            itemCount: collection.itemCount,
            failedSources: collection.failedSources,
          });
          break;
        }
        case 'enriching': {
          const { digestId } = state;
          state = await submitEnrichment(digestId);
          await waitUntilDone(() => checkEnrichment(digestId), input.pollIntervals);
          state = await ingestEnrichment(digestId);
          break;
        }
        case 'synthesizing': {
          const { digestId } = state;
          state = await submitSynthesis(digestId);
          await waitUntilDone(() => checkSynthesis(digestId), input.pollIntervals);
          state = await ingestSynthesis(digestId);
          break;
        }
        case 'rendering':
          state = await publishDigest(state.digestId);
          break;
        case 'failed':
          // beginDigest restarts failed digests, so only a concurrent run can get here
          throw ApplicationFailure.nonRetryable(`digest ${state.digestId} was marked failed`);
      }
    }
  } catch (err) {
    const reason = failureReason(err);
    log.warn('digest failed', { digestId: state.digestId, runId: state.runId, reason });
    await markDigestFailed(state.digestId, reason);
    throw err;
  }

  log.info('digest finished', {
    digestId: state.digestId,
    runId: state.runId,
    status: state.status,
  });
  return state;
}

/** Polls an LLM batch with backoff (durable timers) until it has finished one way or another. */
async function waitUntilDone(
  check: () => Promise<{ done: boolean }>,
  intervals: readonly string[] = BATCH_POLL_INTERVALS,
): Promise<void> {
  for (let attempt = 0; !(await check()).done; attempt++) {
    await sleep(pollDelay(intervals, attempt));
  }
}

/** Activity and child workflow failures wrap the original error; report that one. */
function failureReason(err: unknown): string {
  let current = err;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}
