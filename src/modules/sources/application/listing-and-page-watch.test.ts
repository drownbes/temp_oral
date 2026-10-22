import { beforeEach, describe, expect, it } from 'vitest';
import type { RunId } from '../domain/run-id.ts';
import type { SourceKind, SourceSettingsInput } from '../domain/source.ts';
import { CollectSource } from './collect-source.ts';
import { CreateSource } from './create-source.ts';
import { ExportItems } from './export-items.ts';
import { PreviewSource } from './preview-source.ts';
import {
  collectSourceDeps,
  InMemoryItemContentStore,
  InMemoryItemExporter,
  InMemoryItemRepository,
  InMemoryPageSnapshotRepository,
  InMemorySourceRepository,
  mutableClock,
  StubPageFetcher,
  serveArticle,
  servePage,
} from './testing/fakes.ts';
import { UpdateSource } from './update-source.ts';

const LISTING = 'https://blog.example.com/posts/';
const PAGE = 'https://kernel.example.org/';

const listingPage = (...posts: string[]) =>
  `<nav><a href="/about/">About</a> <a href="https://twitter.com/x">X</a></nav>` +
  posts.map((p) => `<a class="post" href="/posts/${p}/">Post ${p}</a>`).join('');

describe('listing pages and watched pages', () => {
  let sources: InMemorySourceRepository;
  let items: InMemoryItemRepository;
  let snapshots: InMemoryPageSnapshotRepository;
  let fetcher: StubPageFetcher;
  let contentStore: InMemoryItemContentStore;
  let exporter: InMemoryItemExporter;
  let clock: ReturnType<typeof mutableClock>;

  beforeEach(() => {
    sources = new InMemorySourceRepository();
    items = new InMemoryItemRepository();
    snapshots = new InMemoryPageSnapshotRepository();
    fetcher = new StubPageFetcher();
    contentStore = new InMemoryItemContentStore();
    exporter = new InMemoryItemExporter();
    clock = mutableClock();
  });

  const deps = () => collectSourceDeps({ sources, items, fetcher, contentStore, clock, snapshots });
  const create = (url: string, kind: SourceKind, settings: SourceSettingsInput = {}) =>
    new CreateSource({ repository: sources, clock }).execute({
      ownerId: 'default',
      name: 'Example',
      url,
      kind,
      fetchMode: 'http',
      ...settings,
    });
  const collect = (sourceId: string, runId: string) =>
    new CollectSource(deps()).execute(sourceId as never, runId);
  const exported = async (runId: string) => {
    await new ExportItems({ items, sources, contentStore, exporter }).execute(runId);
    return exporter.exports.get(runId as RunId) ?? [];
  };

  describe('listing', () => {
    it('baselines the links it finds, then collects new posts with their article text', async () => {
      const source = await create(LISTING, 'listing', { linkSelector: 'post' });
      servePage(fetcher, LISTING, listingPage('1', '2'));
      expect(await collect(source.id, '2026-10-21')).toMatchObject({ newItems: 2, baseline: true });
      expect(fetcher.requests).toHaveLength(1);

      servePage(fetcher, LISTING, listingPage('3', '1', '2'));
      serveArticle(fetcher, `${LISTING}3/`, 'The third post, in full.');
      expect(await collect(source.id, '2026-10-22')).toMatchObject({
        newItems: 1,
        baseline: false,
        articlesFetched: 1,
      });

      const [line] = await exported('2026-10-22');
      expect(line).toMatchObject({
        text: 'The third post, in full.',
        item: { url: `${LISTING}3/`, title: 'Post 3', kind: 'article' },
      });
    });

    it('does not store a post whose article failed, so the next run tries again', async () => {
      const source = await create(LISTING, 'listing', { linkSelector: 'post' });
      servePage(fetcher, LISTING, listingPage());
      await collect(source.id, '2026-10-21');

      servePage(fetcher, LISTING, listingPage('3'));
      fetcher.responses.set(`${LISTING}3/`, new Error('timeout'));
      expect(await collect(source.id, '2026-10-22')).toMatchObject({
        newItems: 0,
        articleFailures: 1,
      });

      serveArticle(fetcher, `${LISTING}3/`, 'Now it loads.');
      expect(await collect(source.id, '2026-10-23')).toMatchObject({ newItems: 1 });
    });

    it('only follows same-site links matching the pattern when there is no selector', async () => {
      const source = await create(LISTING, 'listing', { urlPattern: '/posts/\\d+/' });
      servePage(fetcher, LISTING, listingPage('1'));
      await collect(source.id, '2026-10-21');
      expect([...items.rows.values()].map((i) => i.url)).toEqual([`${LISTING}1/`]);
    });

    it('previews the links and the first article', async () => {
      servePage(fetcher, LISTING, listingPage('7'));
      serveArticle(fetcher, `${LISTING}7/`, 'Seventh post text.');
      const preview = await new PreviewSource(deps()).execute({
        url: LISTING,
        kind: 'listing',
        fetchMode: 'http',
        linkSelector: 'post',
      });
      expect(preview.entries.map((e) => [e.url, e.title])).toEqual([[`${LISTING}7/`, 'Post 7']]);
      expect(preview.articleSample).toMatchObject({ url: `${LISTING}7/`, articleChars: 18 });
    });
  });

  describe('page watch', () => {
    const page = (lines: string[]) => `<title>Kernel</title><main>${lines.join('\n')}</main>`;

    it('baselines the first version and reports each later change once', async () => {
      const source = await create(PAGE, 'page');
      servePage(fetcher, PAGE, page(['stable: 7.3.4', 'mainline: 7.4-rc1']));
      expect(await collect(source.id, '2026-10-21')).toMatchObject({ newItems: 0, baseline: true });

      // Whitespace-only edits are not changes
      servePage(fetcher, PAGE, page(['  stable:   7.3.4', '', 'mainline: 7.4-rc1  ']));
      expect(await collect(source.id, '2026-10-22')).toMatchObject({ newItems: 0 });

      servePage(fetcher, PAGE, page(['stable: 7.3.5', 'mainline: 7.4-rc1']));
      expect(await collect(source.id, '2026-10-23')).toMatchObject({ newItems: 1 });
      expect(await collect(source.id, '2026-10-23')).toMatchObject({ newItems: 0 });

      const [line] = await exported('2026-10-23');
      expect(line?.item).toMatchObject({ kind: 'change', title: 'Kernel: page changed' });
      expect(line?.item.url).toMatch(/^https:\/\/kernel\.example\.org\/#change-[0-9a-f]{16}$/);
      expect(line?.text).toBe(
        'Kernel: page changed\n\nAdded:\n+ stable: 7.3.5\nRemoved:\n- stable: 7.3.4',
      );
    });

    it('treats a new URL as a new page: baseline again instead of a bogus diff', async () => {
      const source = await create(PAGE, 'page');
      servePage(fetcher, PAGE, page(['one']));
      await collect(source.id, '2026-10-21');

      const other = 'https://other.example.org/';
      await new UpdateSource({ repository: sources, clock }).execute(source.id as never, {
        url: other,
      });
      servePage(fetcher, other, page(['something else entirely']));
      expect(await collect(source.id, '2026-10-22')).toMatchObject({ newItems: 0, baseline: true });
      expect(snapshots.rows.get(source.id)?.url).toBe(other);
    });

    it('previews the text the page would be compared by', async () => {
      servePage(fetcher, PAGE, page(['stable: 7.3.4', '', 'mainline:   7.4-rc1']));
      const preview = await new PreviewSource(deps()).execute({
        url: PAGE,
        kind: 'page',
        fetchMode: 'http',
      });
      expect(preview.pageSample).toEqual({
        title: 'Kernel',
        chars: 31,
        lines: 2,
        excerpt: 'stable: 7.3.4\nmainline: 7.4-rc1',
      });
    });
  });
});
