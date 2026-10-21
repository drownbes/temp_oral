import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollectSourceResult } from '../../application/collect-source.ts';
import { SOURCES_TASK_QUEUE } from '../../contracts/index.ts';
import type { SourceId } from '../../domain/source.ts';
import type { SourceActivities } from './activities.ts';
import { COLLECT_CONCURRENCY } from './definitions.ts';
import { collectSourcesWorkflow } from './workflows.ts';

const collected = (sourceId: string): CollectSourceResult => ({
  sourceId: sourceId as SourceId,
  status: 'collected',
  newItems: 1,
  baseline: false,
});

describe('collectSourcesWorkflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    // ERROR only: the failure-path tests log expected activity/workflow failures at WARN
    Runtime.install({ logger: new DefaultLogger('ERROR') });
    env = await TestWorkflowEnvironment.createLocal({
      server: {
        executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH ?? 'temporal' },
        log: { format: 'pretty', level: 'error' },
      },
    });
  });

  afterAll(() => env?.teardown());

  /** Fake activities that record calls; override the ones a test cares about. */
  function activities(overrides: Partial<SourceActivities> = {}) {
    const calls = { collected: [] as string[], failures: [] as [string, string][], exports: 0 };
    const fakes: SourceActivities = {
      listCollectableSources: async () => ['s1', 's2'],
      collectSource: async (sourceId) => {
        calls.collected.push(sourceId);
        return collected(sourceId);
      },
      recordCollectionFailure: async (sourceId, reason) => {
        calls.failures.push([sourceId, reason]);
      },
      exportItems: async (runId) => {
        calls.exports++;
        return { exportKey: `sources/exports/${runId}.jsonl`, itemCount: 7 };
      },
      ...overrides,
    };
    return { fakes, calls };
  }

  async function run(fakes: SourceActivities, runId = '2026-10-21') {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: SOURCES_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      activities: fakes,
    });
    return worker.runUntil(
      env.client.workflow.execute(collectSourcesWorkflow, {
        taskQueue: SOURCES_TASK_QUEUE,
        workflowId: `test-${crypto.randomUUID()}`,
        args: [{ runId }],
      }),
    );
  }

  it('collects every source, then exports the run once', async () => {
    const { fakes, calls } = activities();

    expect(await run(fakes)).toEqual({
      runId: '2026-10-21',
      exportKey: 'sources/exports/2026-10-21.jsonl',
      itemCount: 7,
      failedSources: [],
    });
    expect(calls.collected.sort()).toEqual(['s1', 's2']);
    expect(calls.exports).toBe(1);
  });

  it('records a failing source and still completes the run', async () => {
    const { fakes, calls } = activities({
      collectSource: async (sourceId) => {
        if (sourceId === 's2')
          throw ApplicationFailure.nonRetryable('HTTP 404', 'SOURCE_FETCH_FAILED');
        return collected(sourceId);
      },
    });

    const result = await run(fakes);
    expect(result.failedSources).toEqual([{ sourceId: 's2', reason: 'HTTP 404' }]);
    expect(calls.failures).toEqual([['s2', 'HTTP 404']]);
    expect(calls.exports).toBe(1);
  });

  it('keeps at most COLLECT_CONCURRENCY sources in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { fakes, calls } = activities({
      listCollectableSources: async () => Array.from({ length: 10 }, (_, i) => `s${i}`),
      collectSource: async (sourceId) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight--;
        calls.collected.push(sourceId);
        return collected(sourceId);
      },
    });

    await run(fakes);
    expect(calls.collected).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(COLLECT_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it('fails the run up front for an invalid run id', async () => {
    const { fakes, calls } = activities({
      listCollectableSources: async () => {
        throw ApplicationFailure.nonRetryable('runId must be a date', 'INVALID_RUN_ID');
      },
    });

    await expect(run(fakes, 'yesterday')).rejects.toThrow('Workflow execution failed');
    expect(calls.collected).toEqual([]);
    expect(calls.exports).toBe(0);
  });
});
