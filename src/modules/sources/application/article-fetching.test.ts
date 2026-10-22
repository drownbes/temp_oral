import { beforeEach, describe, expect, it } from 'vitest';
import type { SourceSnapshot } from '../domain/source.ts';
import { CollectSource } from './collect-source.ts';
import { CreateSource } from './create-source.ts';
import { PreviewSource } from './preview-source.ts';
import {
  FakeArticleExtractor,
  InMemoryItemContentStore,
  InMemoryItemRepository,
  InMemorySourceRepository,
  JsonFeedReader,
  mutableClock,
  StubPageFetcher,
  serveArticle,
} from './testing/fakes.ts';
import { UpdateSource } from './update-source.ts';

const FEED = 'https://example.com/feed.xml';
const ARTICLE = 'https://example.com/posts/new';
const FULL_TEXT = 'The whole article. '.repeat(20);

describe('fetching article pages for teaser feeds', () => {
  let sources: InMemorySourceRepository;
  let items: InMemoryItemRepository;
  let fetcher: StubPageFetcher;
  let contentStore: InMemoryItemContentStore;
  let clock: ReturnType<typeof mutableClock>;
  let source: SourceSnapshot;

  beforeEach(async () => {
    sources = new InMemorySourceRepository();
    items = new InMemoryItemRepository();
    fetcher = new StubPageFetcher();
    contentStore = new InMemoryItemContentStore();
    clock = mutableClock();
    source = await new CreateSource({ repository: sources, clock }).execute({
      ownerId: 'default',
      name: 'Example',
      url: FEED,
      kind: 'feed',
      fetchMode: 'http',
    });
    // Baseline with an empty feed, so later entries are new and exportable
    fetcher.serveFeed(FEED, []);
    await collect('2026-10-21');
    fetcher.requests.length = 0;
  });

  const collect = (runId: string) =>
    new CollectSource({
      sources,
      items,
      fetcher,
      feedReader: new JsonFeedReader(),
      articleExtractor: new FakeArticleExtractor(),
      contentStore,
      clock,
    }).execute(source.id, runId);
  const storedText = () => {
    const [item] = [...items.rows.values()];
    return item ? contentStore.objects.get(item.content.textKey) : undefined;
  };
  const storedRaw = () => {
    const [item] = [...items.rows.values()];
    return item ? contentStore.objects.get(item.content.rawKey) : undefined;
  };

  it('replaces a teaser with the article text and keeps the whole page as raw content', async () => {
    fetcher.serveFeed(FEED, [{ url: ARTICLE, title: 'New', text: 'A short teaser...' }]);
    serveArticle(fetcher, ARTICLE, FULL_TEXT);

    expect(await collect('2026-10-22')).toMatchObject({ articlesFetched: 1, articleFailures: 0 });
    expect(storedText()).toBe(FULL_TEXT);
    expect(storedRaw()).toContain('<nav>menu</nav>');
  });

  it('keeps the teaser when the article cannot be fetched or read', async () => {
    fetcher.serveFeed(FEED, [{ url: ARTICLE, title: 'New', text: 'A short teaser...' }]);
    fetcher.responses.set(ARTICLE, new Error('connection reset'));

    expect(await collect('2026-10-22')).toMatchObject({
      status: 'collected',
      newItems: 1,
      articlesFetched: 0,
      articleFailures: 1,
    });
    expect(storedText()).toBe('A short teaser...');
  });

  it('does not fetch pages for full-text feeds, baseline items, or when disabled', async () => {
    const fullText = 'x'.repeat(2000);
    fetcher.serveFeed(FEED, [{ url: ARTICLE, title: 'New', text: fullText }]);
    await collect('2026-10-22');
    expect(fetcher.requests.map((r) => r.url)).toEqual([FEED]);
    expect(storedText()).toBe(fullText);

    await new UpdateSource({ repository: sources, clock }).execute(source.id, {
      fetchArticles: false,
    });
    fetcher.serveFeed(FEED, [{ url: `${ARTICLE}-2`, title: 'Newer', text: 'teaser' }]);
    await collect('2026-10-23');
    expect(fetcher.requests.map((r) => r.url)).toEqual([FEED, FEED]);

    // A new URL starts over with a baseline: nothing exported, so nothing fetched
    await new UpdateSource({ repository: sources, clock }).execute(source.id, {
      url: 'https://example.com/other.xml',
      fetchArticles: true,
    });
    fetcher.serveFeed('https://example.com/other.xml', [{ url: `${ARTICLE}-3`, title: 'x' }]);
    expect(await collect('2026-10-24')).toMatchObject({ baseline: true, articlesFetched: 0 });
    expect(fetcher.requests.at(-1)?.url).toBe('https://example.com/other.xml');
  });

  it('previews what article fetching makes of the first entry', async () => {
    fetcher.serveFeed(FEED, [{ url: ARTICLE, title: 'New', text: 'A short teaser...' }]);
    serveArticle(fetcher, ARTICLE, FULL_TEXT);
    const preview = new PreviewSource({
      fetcher,
      feedReader: new JsonFeedReader(),
      articleExtractor: new FakeArticleExtractor(),
    });

    const result = await preview.execute({ url: FEED, kind: 'feed', fetchMode: 'http' });
    expect(result.articleSample).toEqual({
      url: ARTICLE,
      feedChars: 17,
      articleChars: FULL_TEXT.length,
      excerpt: FULL_TEXT.slice(0, 300),
    });

    const off = await preview.execute({
      url: FEED,
      kind: 'feed',
      fetchMode: 'http',
      fetchArticles: false,
    });
    expect(off.articleSample).toBeNull();
  });
});
