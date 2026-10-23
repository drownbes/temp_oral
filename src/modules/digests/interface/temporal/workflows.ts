// Runs in Temporal's deterministic sandbox: import only @temporalio/workflow, contracts
// and types. dependency-cruiser enforces this.
import {
  ApplicationFailure,
  executeChild,
  log,
  ParentClosePolicy,
  proxyActivities,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import {
  NOTIFICATIONS_TASK_QUEUE,
  SEND_NOTIFICATION_WORKFLOW,
  type SendNotificationWorkflow,
} from '#modules/notifications/contracts/index.ts';
import {
  COLLECT_SOURCES_WORKFLOW,
  type CollectSourcesWorkflow,
  SOURCES_TASK_QUEUE,
} from '#modules/sources/contracts/index.ts';
import type { DigestEvent } from '../../application/compose-notification.ts';
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

// Telling someone is a courtesy: a few quick tries, then the digest moves on
const { composeNotification } = proxyActivities<DigestActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3, initialInterval: '10 seconds' },
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
    await notify(state.digestId, 'failed');
    throw err;
  }

  log.info('digest finished', {
    digestId: state.digestId,
    runId: state.runId,
    status: state.status,
  });
  if (state.status === 'published') await notify(state.digestId, 'published');
  return state;
}

/**
 * Hands the message to the notifications context, which sends each idempotency key once (so
 * running a day again does not notify again). Started as an independent child: the digest
 * neither waits for delivery nor fails with it.
 */
async function notify(digestId: string, event: DigestEvent): Promise<void> {
  try {
    const message = await composeNotification(digestId, event);
    if (!message) return;
    await startChild<SendNotificationWorkflow>(SEND_NOTIFICATION_WORKFLOW, {
      taskQueue: NOTIFICATIONS_TASK_QUEUE,
      workflowId: `${workflowInfo().workflowId}-notify-${event}`,
      parentClosePolicy: ParentClosePolicy.ABANDON,
      args: [message],
    });
  } catch (err) {
    log.warn('digest notification failed', { digestId, event, reason: failureReason(err) });
  }
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
