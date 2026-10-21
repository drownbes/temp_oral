import { beforeEach, describe, expect, it } from 'vitest';
import type { DigestId } from '../domain/digest.ts';
import { EnrichmentFailedError } from '../domain/errors.ts';
import { BeginDigest } from './begin-digest.ts';
import { CheckEnrichment } from './check-enrichment.ts';
import { IngestEnrichment } from './ingest-enrichment.ts';
import { UpdateInterestProfile } from './interest-profile.ts';
import { MarkDigestFailed } from './mark-digest-failed.ts';
import type { CollectedItem } from './ports.ts';
import { PublishDigest } from './publish-digest.ts';
import { RecordCollection } from './record-collection.ts';
import { StartDigestRun } from './start-digest-run.ts';
import { SubmitEnrichment } from './submit-enrichment.ts';
import {
  FakeItemAnalyzer,
  InMemoryDigestEntryRepository,
  InMemoryDigestRepository,
  InMemoryExportedItemsReader,
  InMemoryInterestProfileRepository,
  mutableClock,
  RecordingDigestRunStarter,
  RecordingPublisher,
} from './testing/fakes.ts';

const OWNER = 'default';
const item = (itemId: string, text = `Text of ${itemId}`): CollectedItem => ({
  itemId,
  sourceId: 's-1',
  sourceName: 'Phoronix',
  url: `https://example.com/${itemId}`,
  title: `Title ${itemId}`,
  publishedAt: new Date('2026-10-20T10:00:00Z'),
  text,
});

describe('a digest run', () => {
  let digests: InMemoryDigestRepository;
  let entries: InMemoryDigestEntryRepository;
  let profiles: InMemoryInterestProfileRepository;
  let reader: InMemoryExportedItemsReader;
  let analyzer: FakeItemAnalyzer;
  let publisher: RecordingPublisher;
  let clock: ReturnType<typeof mutableClock>;

  beforeEach(() => {
    digests = new InMemoryDigestRepository();
    entries = new InMemoryDigestEntryRepository();
    profiles = new InMemoryInterestProfileRepository();
    reader = new InMemoryExportedItemsReader();
    analyzer = new FakeItemAnalyzer();
    publisher = new RecordingPublisher();
    clock = mutableClock();
  });

  const useCases = () => ({
    begin: new BeginDigest({ digests, clock, timezone: 'Europe/Berlin' }),
    record: new RecordCollection({ digests, clock }),
    submit: new SubmitEnrichment({ digests, profiles, reader, analyzer, clock, maxItemChars: 10 }),
    check: new CheckEnrichment({ digests, analyzer }),
    ingest: new IngestEnrichment({ digests, entries, reader, analyzer, clock }),
    publish: new PublishDigest({ digests, entries, profiles, publisher, clock }),
  });

  /** Runs the steps the workflow runs, finishing the batch with `batchState`. */
  async function runDigest(runId: string, items: CollectedItem[], finish = true) {
    const u = useCases();
    const exportKey = `sources/exports/${runId}.jsonl`;
    reader.exports.set(exportKey, items);
    const { digestId } = await u.begin.execute({ ownerId: OWNER, runId, startedAt: '' });
    const id = digestId as DigestId;
    await u.record.execute(id, { exportKey, itemCount: items.length, failedSources: [] });
    await u.submit.execute(id);
    if (finish && items.length > 0) analyzer.finish(`batch-digest-${id}-enrichment`);
    return { id, u };
  }

  it('collects, analyses, ranks by the profile and publishes', async () => {
    await new UpdateInterestProfile({ profiles, clock }).execute(OWNER, {
      interests: 'Linux graphics',
      relevanceThreshold: 0.6,
    });
    analyzer.relevance.set('a', 0.9);
    analyzer.relevance.set('b', 0.3);
    analyzer.failures.set('c', 'model refused');

    const { id, u } = await runDigest(
      '2026-10-21',
      [item('a', 'x'.repeat(50)), item('b'), item('c')],
      false,
    );
    expect(await u.check.execute(id)).toEqual({ done: false });
    analyzer.finish(`batch-digest-${id}-enrichment`);
    expect(await u.check.execute(id)).toEqual({ done: true });
    await u.ingest.execute(id);
    expect(await u.publish.execute(id)).toMatchObject({ status: 'published' });

    const [request] = analyzer.submitted;
    expect(request?.interests).toBe('Linux graphics');
    expect(request?.items[0]?.text).toBe(`${'x'.repeat(10)}…`);

    const [page] = publisher.pages;
    expect(page?.featured.map((e) => e.itemId)).toEqual(['a']);
    expect(page?.alsoNoted.map((e) => e.itemId).sort()).toEqual(['b', 'c']);
    expect(page?.alsoNoted.find((e) => e.itemId === 'c')?.failure).toBe('model refused');
    expect(digests.rows.get(id)).toMatchObject({
      analyzedCount: 2,
      failedItemCount: 1,
      usage: { inputTokens: 300, outputTokens: 10 },
    });
  });

  it('is idempotent at every step and submits one batch per digest', async () => {
    const { id, u } = await runDigest('2026-10-21', [item('a')]);
    await u.submit.execute(id);
    await u.record.execute(id, { exportKey: 'other', itemCount: 99, failedSources: [] });
    await u.ingest.execute(id);
    await u.ingest.execute(id);
    await u.publish.execute(id);
    await u.publish.execute(id);

    expect(analyzer.submitted).toHaveLength(1);
    expect(publisher.pages).toHaveLength(1);
    expect(digests.rows.get(id)?.itemCount).toBe(1);
    expect(entries.rows.size).toBe(1);
    expect(
      (await u.begin.execute({ ownerId: OWNER, runId: '2026-10-21', startedAt: '' })).digestId,
    ).toBe(id);
  });

  it('publishes an all-quiet page without calling the LLM when nothing is new', async () => {
    const { id, u } = await runDigest('2026-10-21', []);
    expect(await u.publish.execute(id)).toMatchObject({ status: 'published' });
    expect(analyzer.submitted).toEqual([]);
    expect(publisher.pages[0]).toMatchObject({ itemCount: 0, featured: [], alsoNoted: [] });
  });

  it('keeps the items an expired batch did not get to, marked as such', async () => {
    const { id, u } = await runDigest('2026-10-21', [item('a'), item('b')], false);
    analyzer.finish(`batch-digest-${id}-enrichment`, {
      state: 'incomplete',
      reason: 'batch expired',
    });
    await u.ingest.execute(id);

    expect(digests.rows.get(id)).toMatchObject({ analyzedCount: 1, failedItemCount: 1 });
    expect(entries.rows.get(`${id}/b`)?.failure).toBe('batch expired');
  });

  it('fails the digest when the batch is rejected, and restarts it on the next begin', async () => {
    const { id, u } = await runDigest('2026-10-21', [item('a')], false);
    analyzer.finish(`batch-digest-${id}-enrichment`, {
      state: 'failed',
      reason: 'model not found',
    });
    await expect(u.ingest.execute(id)).rejects.toThrow(EnrichmentFailedError);
    await new MarkDigestFailed({ digests, clock }).execute(id, 'model not found');
    expect(digests.rows.get(id)?.status).toBe('failed');

    const again = await u.begin.execute({ ownerId: OWNER, runId: '2026-10-21', startedAt: '' });
    expect(again).toEqual({ digestId: id, runId: '2026-10-21', status: 'collecting' });
  });

  it('does not let a late digest overwrite a newer published day', async () => {
    const late = await runDigest('2026-10-21', [item('a')], false);
    const newer = await runDigest('2026-10-22', [item('b')]);
    await newer.u.ingest.execute(newer.id);
    await newer.u.publish.execute(newer.id);

    analyzer.finish(`batch-digest-${late.id}-enrichment`);
    await late.u.ingest.execute(late.id);
    expect(await late.u.publish.execute(late.id)).toMatchObject({ status: 'superseded' });
    expect(publisher.pages.map((p) => p.runId)).toEqual(['2026-10-22']);
  });

  it('derives the run id from the start time in the digest time zone', async () => {
    const begin = new BeginDigest({ digests, clock, timezone: 'Europe/Berlin' });
    const state = await begin.execute({ ownerId: OWNER, startedAt: '2026-10-21T23:30:00Z' });
    expect(state.runId).toBe('2026-10-22');

    const starter = new RecordingDigestRunStarter();
    clock.set('2026-10-21T23:30:00Z');
    await new StartDigestRun({ starter, clock, timezone: 'UTC' }).execute(OWNER);
    expect(starter.started).toEqual([{ ownerId: OWNER, runId: '2026-10-21' }]);
  });
});
