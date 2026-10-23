import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollectSourceResult } from '../../application/collect-source.ts';
import type { SourcePreview } from '../../application/preview-source.ts';
import { SOURCES_TASK_QUEUE } from '../../contracts/index.ts';
import type { FetchMode, SourceId } from '../../domain/source.ts';
import type { BrowserActivities, SourceActivities } from './activities.ts';
import {
  COLLECT_CONCURRENCY,
  type CollectSourcesRunInput,
  SOURCES_BROWSER_TASK_QUEUE,
} from './definitions.ts';
import { collectSourcesWorkflow, previewSourceWorkflow } from './workflows.ts';

const collected = (sourceId: string): CollectSourceResult => ({
  sourceId: sourceId as SourceId,
  status: 'collected',
  newItems: 1,
  baseline: false,
  articlesFetched: 0,
  articleFailures: 0,
  transcriptsFetched: 0,
  transcriptsMissing: 0,
});

const listed = (ids: string[], fetchMode: FetchMode = 'http') =>
  ids.map((id) => ({ sourceId: id as SourceId, fetchMode }));

const preview: SourcePreview = {
  url: 'https://example.com/news',
  entryCount: 1,
  entries: [{ url: 'https://example.com/news/1', title: 'One', publishedAt: null, excerpt: '' }],
  articleSample: null,
  pageSample: null,
  transcriptSample: null,
};

const workflowsPath = fileURLToPath(new URL('./workflows.ts', import.meta.url));

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
    const calls = {
      collected: [] as string[],
      browserCollected: [] as string[],
      failures: [] as [string, string, boolean][],
      exports: 0,
    };
    const fakes: SourceActivities = {
      listCollectableSources: async () => listed(['s1', 's2']),
      collectSource: async (sourceId) => {
        calls.collected.push(sourceId);
        return collected(sourceId);
      },
      recordCollectionFailure: async (sourceId, reason, countsAgainstSource = true) => {
        calls.failures.push([sourceId, reason, countsAgainstSource]);
        // s-dying: this failure is the one that stops it
        return { sourceName: `Name of ${sourceId}`, disabled: sourceId === 's-dying' };
      },
      exportItems: async (runId) => {
        calls.exports++;
        return { exportKey: `sources/exports/${runId}.jsonl`, itemCount: 7 };
      },
      ...overrides,
    };
    const browserFakes: BrowserActivities = {
      collectSource: async (sourceId) => {
        calls.browserCollected.push(sourceId);
        return collected(sourceId);
      },
      previewSource: async () => preview,
    };
    return { fakes, browserFakes, calls };
  }

  /** Runs the workflow; with `browser`, a browser worker serves the browser queue too. */
  async function run(
    fakes: SourceActivities,
    options: { browser?: BrowserActivities; input?: Partial<CollectSourcesRunInput> } = {},
  ) {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: SOURCES_TASK_QUEUE,
      workflowsPath,
      activities: fakes,
    });
    const execution = env.client.workflow.execute(collectSourcesWorkflow, {
      taskQueue: SOURCES_TASK_QUEUE,
      workflowId: `test-${crypto.randomUUID()}`,
      args: [{ runId: '2026-10-21', ...options.input }],
    });
    if (!options.browser) return worker.runUntil(execution);
    const browserWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: SOURCES_BROWSER_TASK_QUEUE,
      activities: options.browser,
    });
    return worker.runUntil(browserWorker.runUntil(execution));
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
    expect(result.failedSources).toEqual([
      { sourceId: 's2', sourceName: 'Name of s2', reason: 'HTTP 404', disabled: false },
    ]);
    expect(calls.failures).toEqual([['s2', 'HTTP 404', true]]);
    expect(calls.exports).toBe(1);
  });

  it('reports a source that this failure stopped', async () => {
    const { fakes } = activities({
      listCollectableSources: async () => listed(['s-dying']),
      collectSource: async () => {
        throw ApplicationFailure.nonRetryable('HTTP 410', 'SOURCE_FETCH_FAILED');
      },
    });
    expect((await run(fakes)).failedSources).toEqual([
      { sourceId: 's-dying', sourceName: 'Name of s-dying', reason: 'HTTP 410', disabled: true },
    ]);
  });

  it('keeps at most COLLECT_CONCURRENCY sources in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { fakes, calls } = activities({
      listCollectableSources: async () => listed(Array.from({ length: 10 }, (_, i) => `s${i}`)),
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

    await expect(run(fakes, { input: { runId: 'yesterday' } })).rejects.toThrow(
      'Workflow execution failed',
    );
    expect(calls.collected).toEqual([]);
    expect(calls.exports).toBe(0);
  });

  it('collects browser sources on the browser queue', async () => {
    const { fakes, browserFakes, calls } = activities({
      listCollectableSources: async () => [...listed(['s1']), ...listed(['spa'], 'browser')],
    });

    const result = await run(fakes, { browser: browserFakes });
    expect(result.failedSources).toEqual([]);
    expect(calls.collected).toEqual(['s1']);
    expect(calls.browserCollected).toEqual(['spa']);
  });

  it('reports browser sources as failed when no browser worker runs', async () => {
    const { fakes, calls } = activities({
      listCollectableSources: async () => [...listed(['s1']), ...listed(['spa'], 'browser')],
    });

    const result = await run(fakes, { input: { browserPickupTimeout: '1 second' } });
    expect(result.failedSources).toEqual([
      {
        sourceId: 'spa',
        sourceName: 'Name of spa',
        reason: expect.stringContaining('no browser worker'),
        disabled: false,
      },
    ]);
    expect(calls.collected).toEqual(['s1']);
    // Reported, but not held against the source
    expect(calls.failures.map(([id, , counts]) => [id, counts])).toEqual([['spa', false]]);
    expect(calls.exports).toBe(1);
  });

  describe('previewSourceWorkflow', () => {
    async function runPreview(browser: BrowserActivities) {
      const { fakes } = activities();
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: SOURCES_TASK_QUEUE,
        workflowsPath,
        activities: fakes,
      });
      const browserWorker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: SOURCES_BROWSER_TASK_QUEUE,
        activities: browser,
      });
      const execution = env.client.workflow.execute(previewSourceWorkflow, {
        taskQueue: SOURCES_TASK_QUEUE,
        workflowId: `test-${crypto.randomUUID()}`,
        args: [{ url: 'https://example.com/news', kind: 'listing', fetchMode: 'browser' }],
      });
      return worker.runUntil(browserWorker.runUntil(execution));
    }

    it('returns the preview made by the browser worker', async () => {
      const { browserFakes } = activities();
      expect(await runPreview(browserFakes)).toEqual(preview);
    });

    it('fails with the activity error type, without retrying', async () => {
      let attempts = 0;
      const { browserFakes } = activities();
      const failing: BrowserActivities = {
        ...browserFakes,
        previewSource: async () => {
          attempts++;
          throw ApplicationFailure.nonRetryable('HTTP 404 from x', 'SOURCE_FETCH_FAILED');
        },
      };

      const error = await runPreview(failing).catch((err: unknown) => err);
      expect(error).toMatchObject({
        cause: { type: 'SOURCE_FETCH_FAILED', message: 'HTTP 404 from x' },
      });
      expect(attempts).toBe(1);
    });
  });
});
