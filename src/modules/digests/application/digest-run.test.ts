import { beforeEach, describe, expect, it } from 'vitest';
import type { DigestId } from '../domain/digest.ts';
import { EnrichmentFailedError } from '../domain/errors.ts';
import { BeginDigest } from './begin-digest.ts';
import { CheckEnrichment } from './check-enrichment.ts';
import { CheckSynthesis } from './check-synthesis.ts';
import { IngestEnrichment } from './ingest-enrichment.ts';
import { IngestSynthesis } from './ingest-synthesis.ts';
import { UpdateInterestProfile } from './interest-profile.ts';
import { MarkDigestFailed } from './mark-digest-failed.ts';
import type { CollectedItem } from './ports.ts';
import { PublishDigest } from './publish-digest.ts';
import { RecordCollection } from './record-collection.ts';
import { StartDigestRun } from './start-digest-run.ts';
import { SubmitEnrichment } from './submit-enrichment.ts';
import { SubmitSynthesis } from './submit-synthesis.ts';
import {
  FakeDigestSynthesizer,
  FakeItemAnalyzer,
  FakeItemEmbedder,
  InMemoryDigestEntryRepository,
  InMemoryDigestRepository,
  InMemoryExportedItemsReader,
  InMemoryInterestProfileRepository,
  mutableClock,
  RecordingDigestRunStarter,
  RecordingPublisher,
} from './testing/fakes.ts';

const OWNER = 'default';
const item = (
  itemId: string,
  sourceName = 'Phoronix',
  text = `Text of ${itemId}`,
): CollectedItem => ({
  itemId,
  kind: 'article',
  sourceId: `src-${sourceName}`,
  sourceName,
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
  let embedder: FakeItemEmbedder;
  let synthesizer: FakeDigestSynthesizer;
  let publisher: RecordingPublisher;
  let clock: ReturnType<typeof mutableClock>;

  beforeEach(() => {
    digests = new InMemoryDigestRepository();
    entries = new InMemoryDigestEntryRepository(digests);
    profiles = new InMemoryInterestProfileRepository();
    reader = new InMemoryExportedItemsReader();
    analyzer = new FakeItemAnalyzer();
    embedder = new FakeItemEmbedder();
    synthesizer = new FakeDigestSynthesizer();
    publisher = new RecordingPublisher();
    clock = mutableClock();
  });

  const steps = () => ({
    begin: new BeginDigest({ digests, clock, timezone: 'Europe/Berlin' }),
    record: new RecordCollection({ digests, clock }),
    submit: new SubmitEnrichment({
      digests,
      profiles,
      reader,
      analyzer,
      embedder,
      clock,
      maxItemChars: 10,
    }),
    check: new CheckEnrichment({ digests, analyzer, embedder }),
    ingest: new IngestEnrichment({
      digests,
      entries,
      reader,
      analyzer,
      embedder,
      clock,
      clusterThreshold: 0.9,
      earlierCoverage: { days: 7, repeat: 0.97, followUp: 0.85 },
    }),
    submitSynthesis: new SubmitSynthesis({ digests, entries, profiles, synthesizer, clock }),
    checkSynthesis: new CheckSynthesis({ digests, synthesizer }),
    ingestSynthesis: new IngestSynthesis({ digests, synthesizer, clock }),
    publish: new PublishDigest({ digests, entries, profiles, publisher, clock }),
  });

  /** The analysis batch of a digest (the fake keys batches as `batch-<key>`). */
  const analysisRef = (id: string) =>
    [...analyzer.batches.keys()].find((ref) => ref.includes(`digest-${id}-analysis-`)) ?? '';

  /** Collects `items` and submits enrichment; batches stay pending. */
  async function startDigest(runId: string, items: CollectedItem[]) {
    const s = steps();
    const exportKey = `sources/exports/${runId}.jsonl`;
    reader.exports.set(exportKey, items);
    const { digestId } = await s.begin.execute({ ownerId: OWNER, runId, startedAt: '' });
    const id = digestId as DigestId;
    await s.record.execute(id, { exportKey, itemCount: items.length, failedSources: [] });
    await s.submit.execute(id);
    return { id, s };
  }

  /** Runs every remaining step with batches completing immediately. */
  async function finishDigest(id: DigestId) {
    const s = steps();
    analyzer.finish(analysisRef(id));
    embedder.fake.finish(id);
    await s.ingest.execute(id);
    await s.submitSynthesis.execute(id);
    synthesizer.fake.finish(id);
    await s.ingestSynthesis.execute(id);
    return s.publish.execute(id);
  }

  it('analyses, groups coverage of one story, synthesises and publishes', async () => {
    await new UpdateInterestProfile({ profiles, clock }).execute(OWNER, {
      interests: 'Linux desktops',
      relevanceThreshold: 0.6,
    });
    analyzer.relevance.set('a', 0.9);
    analyzer.relevance.set('b', 0.7);
    analyzer.relevance.set('c', 0.3);
    analyzer.failures.set('d', 'model refused');
    // a and b are the same story; c and d have vectors of their own
    embedder.vectors.set('a', [1, 0, 0]);
    embedder.vectors.set('b', [0.99, 0.1, 0]);

    const items = [
      item('a', 'Phoronix', 'x'.repeat(50)),
      item('b', '9to5Linux'),
      item('c'),
      item('d'),
    ];
    const { id, s } = await startDigest('2026-10-21', items);

    // Both enrichment batches must finish before ingesting
    expect(await s.check.execute(id)).toEqual({ done: false });
    analyzer.finish(analysisRef(id));
    expect(await s.check.execute(id)).toEqual({ done: false });
    embedder.fake.finish(id);
    expect(await s.check.execute(id)).toEqual({ done: true });

    expect(await s.ingest.execute(id)).toMatchObject({ status: 'synthesizing' });
    expect(digests.rows.get(id)?.clusters.map((c) => c.itemIds)).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
    ]);

    await s.submitSynthesis.execute(id);
    const [synthesis] = synthesizer.fake.submitted;
    expect(synthesis?.interests).toBe('Linux desktops');
    expect(synthesis?.stories.map((st) => st.clusterId)).toEqual(['a']);
    expect(synthesis?.stories[0]?.items.map((i) => i.sourceName)).toEqual([
      'Phoronix',
      '9to5Linux',
    ]);
    expect(synthesis?.highlights.map((h) => h.title)).toEqual(['Title a']);
    expect(await s.checkSynthesis.execute(id)).toEqual({ done: false });
    synthesizer.fake.finish(id);
    await s.ingestSynthesis.execute(id);
    expect(await s.publish.execute(id)).toMatchObject({ status: 'published' });

    expect(analyzer.submitted[0]?.items[0]?.text).toBe(`${'x'.repeat(10)}…`);
    const [page] = publisher.pages;
    expect(page?.overview).toBe('Overview of Title a');
    expect(
      page?.featured.map((st) => [st.cluster.headline, st.entries.map((e) => e.itemId)]),
    ).toEqual([['Merged: Title a', ['a', 'b']]]);
    expect(page?.alsoNoted.map((st) => st.cluster.id).sort()).toEqual(['c', 'd']);
    expect(digests.rows.get(id)).toMatchObject({
      analyzedCount: 3,
      failedItemCount: 1,
      // analysis 4×100 + embeddings 4×5 + synthesis 50 in; analysis 10 + synthesis 20 out
      usage: { inputTokens: 470, outputTokens: 30 },
    });
  });

  it('is idempotent at every step and submits each batch once', async () => {
    const { id, s } = await startDigest('2026-10-21', [item('a')]);
    await s.submit.execute(id);
    await s.record.execute(id, { exportKey: 'other', itemCount: 99, failedSources: [] });
    await finishDigest(id);
    await s.ingest.execute(id);
    await s.submitSynthesis.execute(id);
    await s.ingestSynthesis.execute(id);
    await s.publish.execute(id);

    expect(analyzer.submitted).toHaveLength(1);
    expect(embedder.fake.submitted).toHaveLength(1);
    expect(synthesizer.fake.submitted).toHaveLength(1);
    expect(publisher.pages).toHaveLength(1);
    expect(digests.rows.get(id)?.itemCount).toBe(1);
    const again = await s.begin.execute({ ownerId: OWNER, runId: '2026-10-21', startedAt: '' });
    expect(again.digestId).toBe(id);
  });

  it('publishes an all-quiet page without calling the LLM when nothing is new', async () => {
    const { id, s } = await startDigest('2026-10-21', []);
    expect(await s.publish.execute(id)).toMatchObject({ status: 'published' });
    expect(analyzer.submitted).toEqual([]);
    expect(embedder.fake.submitted).toEqual([]);
    expect(publisher.pages[0]).toMatchObject({ itemCount: 0, featured: [], alsoNoted: [] });
  });

  it('skips the synthesis batch when there is nothing to merge or summarise', async () => {
    analyzer.failures.set('a', 'model refused');
    const { id } = await startDigest('2026-10-21', [item('a')]);
    analyzer.finish(analysisRef(id));
    embedder.fake.finish(id);
    const s = steps();
    await s.ingest.execute(id);

    expect(await s.submitSynthesis.execute(id)).toMatchObject({ status: 'rendering' });
    expect(synthesizer.fake.submitted).toEqual([]);
  });

  it('degrades instead of failing: expired analysis, failed embeddings, failed synthesis', async () => {
    embedder.vectors.set('a', [1, 0]);
    embedder.vectors.set('b', [1, 0]);
    const { id, s } = await startDigest('2026-10-21', [item('a'), item('b')]);
    analyzer.finish(analysisRef(id), {
      state: 'incomplete',
      reason: 'batch expired',
    });
    embedder.fake.finish(id, { state: 'failed', reason: 'quota' });
    await s.ingest.execute(id);

    // The fake analyses only the first item of an incomplete batch; no embeddings → no grouping
    expect(digests.rows.get(id)).toMatchObject({ analyzedCount: 1, failedItemCount: 1 });
    expect(entries.rows.get(`${id}/b`)?.failure).toBe('batch expired');
    expect(digests.rows.get(id)?.clusters).toHaveLength(2);

    await s.submitSynthesis.execute(id);
    synthesizer.fake.finish(id, { state: 'failed', reason: 'bad request' });
    await s.ingestSynthesis.execute(id);
    expect(await s.publish.execute(id)).toMatchObject({ status: 'published' });
    expect(publisher.pages[0]?.overview).toBeNull();
  });

  it('fails the digest when the analysis batch is rejected, and restarts it on the next begin', async () => {
    const { id, s } = await startDigest('2026-10-21', [item('a')]);
    analyzer.finish(analysisRef(id), { state: 'failed', reason: 'model not found' });
    embedder.fake.finish(id);
    await expect(s.ingest.execute(id)).rejects.toThrow(EnrichmentFailedError);
    await new MarkDigestFailed({ digests, clock }).execute(id, 'model not found');
    expect(digests.rows.get(id)?.status).toBe('failed');

    const again = await s.begin.execute({ ownerId: OWNER, runId: '2026-10-21', startedAt: '' });
    expect(again).toEqual({ digestId: id, runId: '2026-10-21', status: 'collecting' });
  });

  it('gives a restarted digest with different items a new batch, not the old results', async () => {
    const { id, s } = await startDigest('2026-10-21', [item('a')]);
    analyzer.finish(analysisRef(id), { state: 'failed', reason: 'model not found' });
    await new MarkDigestFailed({ digests, clock }).execute(id, 'model not found');

    // The day runs again and now also collects b
    await s.begin.execute({ ownerId: OWNER, runId: '2026-10-21', startedAt: '' });
    reader.exports.set('sources/exports/2026-10-21.jsonl', [item('a'), item('b')]);
    await s.record.execute(id, {
      exportKey: 'sources/exports/2026-10-21.jsonl',
      itemCount: 2,
      failedSources: [],
    });
    await s.submit.execute(id);

    expect(analyzer.submitted.map((r) => r.items.map((i) => i.itemId))).toEqual([
      ['a'],
      ['a', 'b'],
    ]);
    expect(embedder.fake.submitted).toHaveLength(2);
  });

  it('does not let a late digest overwrite a newer published day', async () => {
    const late = await startDigest('2026-10-21', [item('a')]);
    const newer = await startDigest('2026-10-22', [item('b')]);
    await finishDigest(newer.id);

    expect(await finishDigest(late.id)).toMatchObject({ status: 'superseded' });
    expect(publisher.pages.map((p) => p.runId)).toEqual(['2026-10-22']);
  });

  it('leaves out stories earlier digests showed and labels follow-ups', async () => {
    // Day one: a and b are published
    embedder.vectors.set('a', [1, 0, 0]);
    embedder.vectors.set('b', [0, 1, 0]);
    const first = await startDigest('2026-10-21', [item('a'), item('b', '9to5Linux')]);
    await finishDigest(first.id);

    // Day two: a repost of a, a follow-up to b (cos 0.89), and something new
    embedder.vectors.set('a-repost', [1, 0, 0]);
    embedder.vectors.set('b-update', [0, 0.89, 0.456]);
    embedder.vectors.set('c', [0, 0, 1]);
    const second = await startDigest('2026-10-22', [
      item('a-repost', 'LXer'),
      item('b-update'),
      item('c', 'Linuxiac'),
    ]);
    await finishDigest(second.id);

    const clusters = digests.rows.get(second.id)?.clusters ?? [];
    expect(clusters.map((c) => [c.id, c.earlier?.kind ?? null])).toEqual([
      ['a-repost', 'repeat'],
      ['b-update', 'follow-up'],
      ['c', null],
    ]);
    expect(clusters[1]?.earlier).toMatchObject({
      runId: '2026-10-21',
      title: 'Title b',
      sourceName: '9to5Linux',
    });

    // The repeat is neither synthesised nor shown, only listed
    const synthesis = synthesizer.fake.submitted.at(-1);
    expect(synthesis?.highlights.map((h) => h.title).sort()).toEqual(['Title b-update', 'Title c']);
    const page = publisher.pages.at(-1);
    expect(page?.featured.map((st) => st.cluster.id).sort()).toEqual(['b-update', 'c']);
    expect(page?.repeated.map((st) => st.cluster.id)).toEqual(['a-repost']);
  });

  it('compares only with published digests of the last days', async () => {
    embedder.vectors.set('old', [1, 0]);
    embedder.vectors.set('unshown', [0, 1]);
    const old = await startDigest('2026-10-10', [item('old')]);
    await finishDigest(old.id);
    // Failed before publishing: the reader never saw it
    const failed = await startDigest('2026-10-20', [item('unshown')]);
    await new MarkDigestFailed({ digests, clock }).execute(failed.id, 'model not found');

    embedder.vectors.set('old-again', [1, 0]);
    embedder.vectors.set('unshown-again', [0, 1]);
    const today = await startDigest('2026-10-21', [item('old-again'), item('unshown-again')]);
    await finishDigest(today.id);

    expect(digests.rows.get(today.id)?.clusters.map((c) => c.earlier)).toEqual([null, null]);
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
