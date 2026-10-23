import { beforeEach, describe, expect, it } from 'vitest';
import { CollectSource } from './collect-source.ts';
import { CreateSource } from './create-source.ts';
import { ListCollectableSources } from './list-collectable-sources.ts';
import {
  type BrowserPreviewer,
  PreviewSource,
  type PreviewSourceCommand,
  type SourcePreview,
} from './preview-source.ts';
import {
  collectSourceDeps,
  InMemoryItemContentStore,
  InMemoryItemRepository,
  InMemorySourceRepository,
  mutableClock,
  PassingSourceChecker,
  StubPageFetcher,
  serveArticle,
  servePage,
} from './testing/fakes.ts';

const NEWS = 'https://spa.example.com/news/';

/** Records what it was asked to preview. */
class RecordingBrowserPreviewer implements BrowserPreviewer {
  readonly commands: PreviewSourceCommand[] = [];

  async preview(command: PreviewSourceCommand): Promise<SourcePreview> {
    this.commands.push(command);
    return { url: command.url, entryCount: 0, entries: [], articleSample: null, pageSample: null };
  }
}

describe('browser sources', () => {
  let sources: InMemorySourceRepository;
  let items: InMemoryItemRepository;
  let fetcher: StubPageFetcher;
  let contentStore: InMemoryItemContentStore;
  const clock = mutableClock();

  beforeEach(() => {
    sources = new InMemorySourceRepository();
    items = new InMemoryItemRepository();
    fetcher = new StubPageFetcher();
    contentStore = new InMemoryItemContentStore();
  });

  const deps = () => collectSourceDeps({ sources, items, fetcher, contentStore, clock });
  const createListing = () =>
    new CreateSource({ repository: sources, checker: new PassingSourceChecker(), clock })
      .execute({
        ownerId: 'default',
        name: 'SPA news',
        url: NEWS,
        kind: 'listing',
        fetchMode: 'browser',
        waitForSelector: '.news-list',
        linkSelector: 'post',
      })
      .then((r) => r.source);

  it('lists each collectable source with its fetch mode', async () => {
    const source = await createListing();
    expect(await new ListCollectableSources(sources).execute('2026-10-21')).toEqual([
      { sourceId: source.id, fetchMode: 'browser' },
    ]);
  });

  it('waits for the selector on the source page only, not on its articles', async () => {
    const source = await createListing();
    servePage(fetcher, NEWS, '<a class="post" href="/news/1/">One</a>');
    await new CollectSource(deps()).execute(source.id, '2026-10-21');
    servePage(fetcher, NEWS, '<a class="post" href="/news/2/">Two</a>');
    serveArticle(fetcher, `${NEWS}2/`, 'Second post.');
    await new CollectSource(deps()).execute(source.id, '2026-10-22');

    expect(fetcher.requests.map((r) => [r.url, r.waitForSelector ?? null])).toEqual([
      [NEWS, '.news-list'],
      [NEWS, '.news-list'],
      [`${NEWS}2/`, null],
    ]);
  });

  describe('preview', () => {
    const command: PreviewSourceCommand = {
      url: NEWS,
      kind: 'listing',
      fetchMode: 'browser',
      waitForSelector: '.news-list',
      linkSelector: 'post',
    };

    it('hands browser previews to the browser previewer, and HTTP previews not', async () => {
      const previewer = new RecordingBrowserPreviewer();
      const preview = new PreviewSource({ ...deps(), browserPreviewer: previewer });
      servePage(fetcher, NEWS, '<a class="post" href="/news/1/">One</a>');

      await preview.execute(command);
      await preview.execute({ ...command, fetchMode: 'http' });
      expect(previewer.commands).toEqual([command]);
      expect(fetcher.requests).toHaveLength(2); // the HTTP preview: page + first article
    });

    it('renders itself where no previewer is set (the browser worker)', async () => {
      servePage(fetcher, NEWS, '<a class="post" href="/news/1/">One</a>');
      serveArticle(fetcher, `${NEWS}1/`, 'First post.');

      const preview = await new PreviewSource(deps()).execute(command);
      expect(preview.entries.map((e) => e.title)).toEqual(['One']);
      expect(fetcher.requests[0]).toMatchObject({ url: NEWS, waitForSelector: '.news-list' });
    });
  });
});
