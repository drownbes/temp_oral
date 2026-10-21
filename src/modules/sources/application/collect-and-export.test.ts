import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidRunIdError } from '../domain/errors.ts';
import type { RunId } from '../domain/run-id.ts';
import type { SourceSnapshot } from '../domain/source.ts';
import { CollectSource } from './collect-source.ts';
import { CreateSource } from './create-source.ts';
import { ExportItems } from './export-items.ts';
import { RecordCollectionFailure } from './record-collection-failure.ts';
import {
  InMemoryItemContentStore,
  InMemoryItemExporter,
  InMemoryItemRepository,
  InMemorySourceRepository,
  JsonFeedReader,
  mutableClock,
  StubPageFetcher,
} from './testing/fakes.ts';
import { UpdateSource } from './update-source.ts';

const FEED = 'https://example.com/feed.xml';

describe('collecting a source and exporting a run', () => {
  let sources: InMemorySourceRepository;
  let items: InMemoryItemRepository;
  let fetcher: StubPageFetcher;
  let contentStore: InMemoryItemContentStore;
  let exporter: InMemoryItemExporter;
  let clock: ReturnType<typeof mutableClock>;
  let source: SourceSnapshot;

  beforeEach(async () => {
    sources = new InMemorySourceRepository();
    items = new InMemoryItemRepository();
    fetcher = new StubPageFetcher();
    contentStore = new InMemoryItemContentStore();
    exporter = new InMemoryItemExporter();
    clock = mutableClock();
    source = await new CreateSource({ repository: sources, clock }).execute({
      ownerId: 'default',
      name: 'Example',
      url: FEED,
      kind: 'feed',
      fetchMode: 'http',
    });
  });

  const collect = (runId: string) =>
    new CollectSource({
      sources,
      items,
      fetcher,
      feedReader: new JsonFeedReader(),
      contentStore,
      clock,
    }).execute(source.id, runId);
  const exportRun = (runId: string) =>
    new ExportItems({ items, sources, contentStore, exporter }).execute(runId);

  it('records the first collection as a baseline and exports nothing from it', async () => {
    fetcher.serveFeed(FEED, [
      { url: 'https://example.com/a', title: 'A' },
      { url: '/b', title: 'B' },
    ]);

    expect(await collect('2026-10-21')).toMatchObject({
      status: 'collected',
      newItems: 2,
      baseline: true,
    });
    expect(await exportRun('2026-10-21')).toEqual({
      exportKey: 'exports/2026-10-21.jsonl',
      itemCount: 0,
    });
    expect(sources.rows.get(source.id)?.baselinedAt).toEqual(clock.now());
  });

  it('exports only entries that appeared after the baseline, with their text', async () => {
    fetcher.serveFeed(FEED, [{ url: 'https://example.com/a', title: 'A' }]);
    await collect('2026-10-21');

    clock.set('2026-10-22T06:00:00Z');
    fetcher.serveFeed(FEED, [
      { url: 'https://example.com/c', title: 'C' },
      { url: 'https://example.com/a', title: 'A' },
    ]);
    expect(await collect('2026-10-22')).toMatchObject({ newItems: 1, baseline: false });

    const result = await exportRun('2026-10-22');
    expect(result.itemCount).toBe(1);
    const [line] = exporter.exports.get('2026-10-22' as RunId) ?? [];
    expect(line).toMatchObject({
      sourceName: 'Example',
      text: 'C',
      item: { url: 'https://example.com/c', title: 'C', exportedInRun: '2026-10-22' },
    });
  });

  it('is idempotent: collecting or exporting the same run twice changes nothing', async () => {
    fetcher.serveFeed(FEED, []);
    await collect('2026-10-21');
    fetcher.serveFeed(FEED, [{ url: 'https://example.com/c', title: 'C' }]);

    await collect('2026-10-22');
    await collect('2026-10-22');
    const first = await exportRun('2026-10-22');
    const second = await exportRun('2026-10-22');

    expect(items.rows.size).toBe(1);
    expect(second).toEqual(first);
    expect(first.itemCount).toBe(1);
  });

  it('hands each item to exactly one run, and later runs pick up what is left', async () => {
    fetcher.serveFeed(FEED, []);
    await collect('2026-10-21');
    fetcher.serveFeed(FEED, [{ url: 'https://example.com/c', title: 'C' }]);
    await collect('2026-10-22');
    await exportRun('2026-10-22');

    // Collected after the 22nd was exported (e.g. a manual run), so it goes to the next run
    fetcher.serveFeed(FEED, [{ url: 'https://example.com/d', title: 'D' }]);
    await collect('2026-10-22');

    expect((await exportRun('2026-10-23')).itemCount).toBe(1);
    expect(exporter.exports.get('2026-10-23' as RunId)?.[0]?.item.title).toBe('D');
    expect((await exportRun('2026-10-22')).itemCount).toBe(1);
  });

  it('sends validators back and short-circuits when not modified', async () => {
    fetcher.serveFeed(FEED, [], '"v1"');
    await collect('2026-10-21');

    fetcher.responses.set(FEED, { status: 'not-modified' });
    expect(await collect('2026-10-22')).toMatchObject({ status: 'not-modified', newItems: 0 });
    expect(fetcher.requests.at(-1)?.validators).toEqual({ etag: '"v1"', lastModified: null });
    expect(sources.rows.get(source.id)?.validators.etag).toBe('"v1"');
  });

  it('skips disabled sources without fetching', async () => {
    await new UpdateSource({ repository: sources, clock }).execute(source.id, { enabled: false });
    expect(await collect('2026-10-21')).toMatchObject({ status: 'skipped' });
    expect(fetcher.requests).toEqual([]);
  });

  it('leaves failure bookkeeping to RecordCollectionFailure', async () => {
    fetcher.responses.set(FEED, new Error('connection reset'));
    await expect(collect('2026-10-21')).rejects.toThrow('connection reset');
    expect(sources.rows.get(source.id)?.consecutiveFailures).toBe(0);

    await new RecordCollectionFailure({ repository: sources, clock }).execute(
      source.id,
      'connection reset',
    );
    expect(sources.rows.get(source.id)).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'connection reset',
    });
  });

  it('rejects malformed run ids', async () => {
    await expect(collect('yesterday')).rejects.toThrow(InvalidRunIdError);
    await expect(exportRun('2026-13-01')).rejects.toThrow(InvalidRunIdError);
  });
});
