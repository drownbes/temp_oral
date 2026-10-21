import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOURCES_TASK_QUEUE } from '#modules/sources/contracts/index.ts';
import type { DigestState } from '../../application/digest-state.ts';
import type { DigestStatus } from '../../domain/digest.ts';
import type { DigestActivities } from './activities.ts';
import { type DailyDigestInput, DIGESTS_TASK_QUEUE } from './definitions.ts';
import { dailyDigestWorkflow } from './workflows.ts';

const workflowsPath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** Digest activities backed by a tiny state machine, recording every call. */
function fakeDigest(options: {
  initial?: DigestStatus;
  itemCount?: number;
  pollsUntilDone?: number;
  ingest?: () => Promise<void>;
}) {
  const calls: string[] = [];
  let status: DigestStatus = options.initial ?? 'collecting';
  let polls = 0;
  const state = (): DigestState => ({ digestId: 'd-1', runId: '2026-10-21', status });
  const failures: string[] = [];
  const activities: DigestActivities = {
    beginDigest: async (command) => {
      calls.push(`begin:${command.runId ?? 'scheduled'}`);
      return state();
    },
    recordCollection: async (_id, outcome) => {
      calls.push(`record:${outcome.itemCount}:${outcome.exportKey}`);
      status = outcome.itemCount > 0 ? 'enriching' : 'rendering';
      return state();
    },
    submitEnrichment: async () => {
      calls.push('submit');
      return state();
    },
    checkEnrichment: async () => {
      calls.push('check');
      return { done: ++polls > (options.pollsUntilDone ?? 0) };
    },
    ingestEnrichment: async () => {
      calls.push('ingest');
      await options.ingest?.();
      status = 'synthesizing';
      return state();
    },
    submitSynthesis: async () => {
      calls.push('synthesize');
      return state();
    },
    checkSynthesis: async () => {
      calls.push('check-synthesis');
      return { done: true };
    },
    ingestSynthesis: async () => {
      calls.push('ingest-synthesis');
      status = 'rendering';
      return state();
    },
    publishDigest: async () => {
      calls.push('publish');
      status = 'published';
      return state();
    },
    markDigestFailed: async (_id, reason) => {
      failures.push(reason);
    },
  };
  return { activities, calls, failures };
}

describe('dailyDigestWorkflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    // ERROR only: the failure-path test logs expected activity/workflow failures at WARN
    Runtime.install({ logger: new DefaultLogger('ERROR') });
    env = await TestWorkflowEnvironment.createLocal({
      server: {
        executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH ?? 'temporal' },
        log: { format: 'pretty', level: 'error' },
      },
    });
  });

  afterAll(() => env?.teardown());

  /** Runs the digest workflow next to the real sources workflow with fake source activities. */
  async function run(digestActivities: DigestActivities, itemCount = 2) {
    const collectedRuns: string[] = [];
    const [digestsWorker, sourcesWorker] = await Promise.all([
      Worker.create({
        connection: env.nativeConnection,
        taskQueue: DIGESTS_TASK_QUEUE,
        workflowsPath: workflowsPath('./workflows.ts'),
        activities: digestActivities,
      }),
      Worker.create({
        connection: env.nativeConnection,
        taskQueue: SOURCES_TASK_QUEUE,
        workflowsPath: workflowsPath('../../../sources/interface/temporal/workflows.ts'),
        activities: {
          listCollectableSources: async () => [],
          collectSource: async () => {
            throw new Error('no sources');
          },
          recordCollectionFailure: async () => {},
          exportItems: async (runId: string) => {
            collectedRuns.push(runId);
            return { exportKey: `sources/exports/${runId}.jsonl`, itemCount };
          },
        },
      }),
    ]);
    const input: DailyDigestInput = {
      ownerId: 'default',
      runId: '2026-10-21',
      pollIntervals: ['10ms', '20ms', '30ms'],
    };
    const handle = await env.client.workflow.start(dailyDigestWorkflow, {
      taskQueue: DIGESTS_TASK_QUEUE,
      workflowId: `test-${crypto.randomUUID()}`,
      args: [input],
    });
    const result = digestsWorker.runUntil(sourcesWorker.runUntil(handle.result()));
    /** The timer durations the workflow slept for, in ms, from its history. */
    const timers = async () =>
      ((await handle.fetchHistory()).events ?? []).flatMap((e) => {
        const timeout = e.timerStartedEventAttributes?.startToFireTimeout;
        return timeout ? [Number(timeout.seconds ?? 0) * 1000 + (timeout.nanos ?? 0) / 1e6] : [];
      });
    return { result, collectedRuns, timers };
  }

  it('collects through the sources contract, waits for the batch, then publishes', async () => {
    const digest = fakeDigest({ pollsUntilDone: 4 });
    const { result, collectedRuns, timers } = await run(digest.activities);

    expect(await result).toEqual({ digestId: 'd-1', runId: '2026-10-21', status: 'published' });
    expect(collectedRuns).toEqual(['2026-10-21']);
    expect(digest.calls).toEqual([
      'begin:2026-10-21',
      'record:2:sources/exports/2026-10-21.jsonl',
      'submit',
      'check',
      'check',
      'check',
      'check',
      'check',
      'ingest',
      'synthesize',
      'check-synthesis',
      'ingest-synthesis',
      'publish',
    ]);
    // Backs off through the intervals, then keeps repeating the last one
    expect(await timers()).toEqual([10, 20, 30, 30]);
  });

  it('goes straight to publishing when nothing was collected', async () => {
    const digest = fakeDigest({});
    const { result } = await run(digest.activities, 0);

    await result;
    expect(digest.calls).toEqual([
      'begin:2026-10-21',
      'record:0:sources/exports/2026-10-21.jsonl',
      'publish',
    ]);
  });

  it('resumes a digest that was already waiting for its batch, without collecting again', async () => {
    const digest = fakeDigest({ initial: 'enriching' });
    const { result, collectedRuns } = await run(digest.activities);

    await result;
    expect(collectedRuns).toEqual([]);
    expect(digest.calls).toEqual([
      'begin:2026-10-21',
      'submit',
      'check',
      'ingest',
      'synthesize',
      'check-synthesis',
      'ingest-synthesis',
      'publish',
    ]);
  });

  it('does nothing for a digest that is already published', async () => {
    const digest = fakeDigest({ initial: 'published' });
    const { result } = await run(digest.activities);

    await result;
    expect(digest.calls).toEqual(['begin:2026-10-21']);
  });

  it('marks the digest failed with the underlying reason and fails the run', async () => {
    const digest = fakeDigest({
      ingest: async () => {
        throw ApplicationFailure.nonRetryable('batch failed: model not found', 'ENRICHMENT_FAILED');
      },
    });
    const { result } = await run(digest.activities);

    await expect(result).rejects.toThrow('Workflow execution failed');
    expect(digest.failures).toEqual(['batch failed: model not found']);
    expect(digest.calls).not.toContain('publish');
  });
});
