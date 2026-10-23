import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidSourceError, SourceFetchError } from '../domain/errors.ts';
import { CheckSource } from './check-source.ts';
import { CollectSource } from './collect-source.ts';
import { CreateSource } from './create-source.ts';
import { PreviewSource } from './preview-source.ts';
import {
  collectSourceDeps,
  FakeYouTube,
  InMemoryItemContentStore,
  InMemoryItemRepository,
  InMemorySourceRepository,
  mutableClock,
  PassingSourceChecker,
  StubPageFetcher,
} from './testing/fakes.ts';
import { UpdateSource } from './update-source.ts';

const CHANNEL_ID = 'UCHnyfMqiRRG1u-2MsSQLbXA';
const CHANNEL = `https://www.youtube.com/channel/${CHANNEL_ID}`;
const HANDLE = 'https://www.youtube.com/@veritasium';
const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const video = (id: string) => `https://www.youtube.com/watch?v=${id}`;

describe('YouTube sources', () => {
  let sources: InMemorySourceRepository;
  let items: InMemoryItemRepository;
  let fetcher: StubPageFetcher;
  let contentStore: InMemoryItemContentStore;
  let youtube: FakeYouTube;
  const clock = mutableClock();

  beforeEach(() => {
    sources = new InMemorySourceRepository();
    items = new InMemoryItemRepository();
    fetcher = new StubPageFetcher();
    contentStore = new InMemoryItemContentStore();
    youtube = new FakeYouTube();
    youtube.channels.set(HANDLE, CHANNEL_ID);
    clock.set('2026-10-21T06:00:00Z');
  });

  const deps = () => collectSourceDeps({ sources, items, fetcher, contentStore, clock, youtube });
  const create = (url = HANDLE) =>
    new CreateSource({
      repository: sources,
      checker: new PassingSourceChecker(),
      channels: youtube,
      clock,
    })
      .execute({ ownerId: 'default', name: 'Veritasium', url, kind: 'youtube', fetchMode: 'http' })
      .then((r) => r.source);
  const collect = (sourceId: string, runId: string) =>
    new CollectSource(deps()).execute(sourceId as never, runId);
  const storedText = (url: string) => {
    const item = [...items.rows.values()].find((i) => i.url === url);
    return item && contentStore.readText(item.content.textKey);
  };

  it('saves a handle as the channel it names', async () => {
    expect((await create()).url).toBe(CHANNEL);
    // Already a channel URL: no lookup needed
    youtube.channels.clear();
    sources.rows.clear();
    expect((await create(`${CHANNEL}/videos`)).url).toBe(CHANNEL);
  });

  it('refuses URLs that are not a YouTube channel', async () => {
    await expect(create('https://example.com/@veritasium')).rejects.toThrow(InvalidSourceError);
    await expect(create('https://www.youtube.com/@nobody')).rejects.toThrow(SourceFetchError);
  });

  it('collects new videos from the feed with their transcript, leaving out Shorts', async () => {
    const source = await create();
    fetcher.serveFeed(FEED, [
      { url: video('old00000000'), title: 'Old', publishedAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    await collect(source.id, '2026-10-21');
    expect(youtube.transcribed).toEqual([]); // the baseline needs no transcripts

    clock.set('2026-10-22T06:00:00Z');
    youtube.transcripts.set('new00000000', 'What is said in the video');
    youtube.transcripts.set('fail0000000', new Error('YouTube does not play fail0000000'));
    fetcher.serveFeed(FEED, [
      { url: video('new00000000'), title: 'New', text: 'Sponsored by…' },
      { url: 'https://www.youtube.com/shorts/short000000', title: 'Short' },
      { url: video('mute0000000'), title: 'No captions', text: 'Only a description' },
      { url: video('fail0000000'), title: 'Blocked', text: 'Its description' },
      { url: video('old00000000'), title: 'Old' },
    ]);
    const result = await collect(source.id, '2026-10-22');

    expect(result).toMatchObject({ newItems: 3, transcriptsFetched: 1, transcriptsMissing: 2 });
    expect(await storedText(video('new00000000'))).toBe(
      'What is said in the video\n\nVideo description:\nSponsored by…',
    );
    expect(await storedText(video('mute0000000'))).toBe('Only a description');
    expect(await storedText(video('fail0000000'))).toBe('Its description');
    expect([...items.rows.values()].some((i) => i.url.includes('/shorts/'))).toBe(false);
  });

  it('becomes a different channel when its URL changes', async () => {
    const source = await create();
    youtube.channels.set('https://www.youtube.com/@other', 'UC0000000000000000000000');
    const update = new UpdateSource({
      repository: sources,
      checker: new PassingSourceChecker(),
      channels: youtube,
      clock,
    });
    const { source: updated } = await update.execute(source.id, {
      url: 'https://www.youtube.com/@other',
    });
    expect(updated).toMatchObject({
      url: 'https://www.youtube.com/channel/UC0000000000000000000000',
      baselinedAt: null,
    });
  });

  describe('preview and check', () => {
    const preview = () => new PreviewSource(deps());

    it('shows the videos and the first one transcript, under the channel URL', async () => {
      youtube.transcripts.set('new00000000', 'What is said in the video');
      fetcher.serveFeed(FEED, [
        { url: 'https://www.youtube.com/shorts/short000000', title: 'Short' },
        { url: video('new00000000'), title: 'New' },
      ]);
      expect(
        await preview().execute({ url: HANDLE, kind: 'youtube', fetchMode: 'http' }),
      ).toMatchObject({
        url: CHANNEL,
        entryCount: 1,
        transcriptSample: {
          url: video('new00000000'),
          chars: 25,
          excerpt: 'What is said in the video',
        },
      });
    });

    it('refuses browser fetching', async () => {
      await expect(
        preview().execute({ url: CHANNEL, kind: 'youtube', fetchMode: 'browser' }),
      ).rejects.toThrow(
        new InvalidSourceError('youtube sources are read over http, not in a browser'),
      );
    });

    it('warns without a transcript and refuses a channel without videos', async () => {
      const checker = new CheckSource(preview());
      fetcher.serveFeed(FEED, [{ url: video('mute0000000'), title: 'No captions' }]);
      const { warnings } = await checker.check({
        url: CHANNEL,
        kind: 'youtube',
        fetchMode: 'http',
      });
      expect(warnings).toEqual([
        `no transcript for ${video('mute0000000')} (the video has no captions); videos without one keep their description`,
      ]);

      fetcher.serveFeed(FEED, [{ url: 'https://www.youtube.com/shorts/short000000', title: 'S' }]);
      await expect(
        checker.check({ url: CHANNEL, kind: 'youtube', fetchMode: 'http' }),
      ).rejects.toThrow(`${CHANNEL} has no videos (Shorts are left out)`);
    });
  });
});
