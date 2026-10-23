import { Item, type ItemContentKeys, type ItemId, type ItemSnapshot } from '../../domain/item.ts';
import type { ItemRepository } from '../../domain/item-repository.ts';
import { PageSnapshot, type PageSnapshotState } from '../../domain/page-watch.ts';
import type { RunId } from '../../domain/run-id.ts';
import { Source, type SourceId, type SourceSnapshot } from '../../domain/source.ts';
import type { PageSnapshotRepository, SourceRepository } from '../../domain/source-repository.ts';
import type {
  ArticleExtractor,
  CollectionStarter,
  ExportLine,
  ExtractedArticle,
  FeedEntry,
  FeedReader,
  FetchRequest,
  FetchResult,
  ItemContentLocation,
  ItemContentStore,
  ItemExporter,
  LinkExtractor,
  ListingLink,
  PageFetcher,
  PageText,
  PageTextExtractor,
} from '../ports.ts';

/** In-memory adapters for testing use cases without infrastructure. */
export class InMemorySourceRepository implements SourceRepository {
  readonly rows = new Map<SourceId, SourceSnapshot>();

  async findById(id: SourceId): Promise<Source | undefined> {
    const row = this.rows.get(id);
    return row && Source.restore(row);
  }

  async findByIds(ids: readonly SourceId[]): Promise<Source[]> {
    return ids.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [Source.restore(row)] : [];
    });
  }

  async findActiveByUrl(ownerId: string, url: string): Promise<Source | undefined> {
    const row = [...this.rows.values()].find(
      (s) => s.ownerId === ownerId && s.url === url && !s.archivedAt,
    );
    return row && Source.restore(row);
  }

  async listActive(ownerId: string): Promise<Source[]> {
    return [...this.rows.values()]
      .filter((s) => s.ownerId === ownerId && !s.archivedAt)
      .map((s) => Source.restore(s));
  }

  async listCollectable(): Promise<Source[]> {
    return [...this.rows.values()]
      .filter((s) => s.enabled && !s.archivedAt)
      .map((s) => Source.restore(s));
  }

  async save(source: Source): Promise<void> {
    this.rows.set(source.id, source.toSnapshot());
  }
}

export class InMemoryItemRepository implements ItemRepository {
  readonly rows = new Map<ItemId, ItemSnapshot>();

  async knownUrls(sourceId: SourceId, urls: readonly string[]): Promise<Set<string>> {
    const stored = [...this.rows.values()].filter((i) => i.sourceId === sourceId);
    return new Set(urls.filter((url) => stored.some((i) => i.url === url)));
  }

  async addNew(items: readonly Item[]): Promise<void> {
    for (const item of items) {
      if (!this.rows.has(item.id)) this.rows.set(item.id, item.toSnapshot());
    }
  }

  async listBySource(sourceId: SourceId, limit: number): Promise<Item[]> {
    return [...this.rows.values()]
      .filter((i) => i.sourceId === sourceId)
      .sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime())
      .slice(0, limit)
      .map((i) => Item.restore(i));
  }

  async claimForRun(runId: RunId): Promise<Item[]> {
    for (const [id, item] of this.rows) {
      if (!item.baseline && item.exportedInRun === null) {
        this.rows.set(id, { ...item, exportedInRun: runId });
      }
    }
    return [...this.rows.values()]
      .filter((i) => i.exportedInRun === runId)
      .map((i) => Item.restore(i));
  }
}

/** Serves canned responses per URL; an Error value is thrown. */
export class StubPageFetcher implements PageFetcher {
  readonly responses = new Map<string, FetchResult | Error>();
  readonly requests: FetchRequest[] = [];

  async fetch(request: FetchRequest): Promise<FetchResult> {
    this.requests.push(request);
    const response = this.responses.get(request.url);
    if (!response) throw new Error(`no stub response for ${request.url}`);
    if (response instanceof Error) throw response;
    return response;
  }

  /** Serves `entries` as the feed body understood by JsonFeedReader. */
  serveFeed(url: string, entries: readonly Partial<FeedEntry>[], etag: string | null = null) {
    this.responses.set(url, {
      status: 'ok',
      url,
      contentType: 'application/json',
      body: JSON.stringify(entries),
      validators: { etag, lastModified: null },
    });
  }
}

/** Serves an article page whose body is `<article>text</article>`. */
export function serveArticle(
  fetcher: StubPageFetcher,
  url: string,
  text: string,
  title = '',
): void {
  fetcher.responses.set(url, {
    status: 'ok',
    url,
    contentType: 'text/html',
    body: `<html><title>${title}</title><nav>menu</nav><article>${text}</article></html>`,
    validators: { etag: null, lastModified: null },
  });
}

/** Reads what serveArticle served; any other page has no article. */
export class FakeArticleExtractor implements ArticleExtractor {
  extract(html: string): ExtractedArticle | undefined {
    const text = /<article>(.*)<\/article>/s.exec(html)?.[1];
    const title = /<title>(.*)<\/title>/.exec(html)?.[1] ?? '';
    return text ? { title, html: `<article>${text}</article>`, text } : undefined;
  }
}

/** Reads a JSON array of entries; title doubles as content. */
export class JsonFeedReader implements FeedReader {
  read(body: string): FeedEntry[] {
    return (JSON.parse(body) as Partial<FeedEntry>[]).map((e) => ({
      url: e.url ?? '',
      title: e.title ?? '',
      publishedAt: e.publishedAt ? new Date(e.publishedAt) : null,
      html: `<p>${e.text ?? e.title ?? ''}</p>`,
      text: e.text ?? e.title ?? '',
    }));
  }
}

export class InMemoryItemContentStore implements ItemContentStore {
  readonly objects = new Map<string, string>();

  async put(
    { sourceId, runId, itemId }: ItemContentLocation,
    content: { html: string; text: string },
  ): Promise<ItemContentKeys> {
    const base = `raw/${sourceId}/${runId}/${itemId}`;
    const keys = { rawKey: `${base}.html`, textKey: `${base}.txt` };
    this.objects.set(keys.rawKey, content.html);
    this.objects.set(keys.textKey, content.text);
    return keys;
  }

  async readText(key: string): Promise<string> {
    const text = this.objects.get(key);
    if (text === undefined) throw new Error(`no object ${key}`);
    return text;
  }
}

export class InMemoryItemExporter implements ItemExporter {
  readonly exports = new Map<RunId, readonly ExportLine[]>();

  async write(runId: RunId, lines: readonly ExportLine[]): Promise<string> {
    this.exports.set(runId, lines);
    return `exports/${runId}.jsonl`;
  }
}

export class RecordingCollectionStarter implements CollectionStarter {
  readonly started: RunId[] = [];

  async start(runId: RunId): Promise<{ workflowId: string }> {
    this.started.push(runId);
    return { workflowId: `collect-sources-${runId}` };
  }
}

/** A clock that can be moved forward, so consecutive runs get distinct timestamps. */
export function mutableClock(iso = '2026-10-21T06:00:00Z') {
  let now = new Date(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next);
    },
  };
}

export class InMemoryPageSnapshotRepository implements PageSnapshotRepository {
  readonly rows = new Map<SourceId, PageSnapshotState>();

  async find(sourceId: SourceId): Promise<PageSnapshot | undefined> {
    const row = this.rows.get(sourceId);
    return row && PageSnapshot.restore(row);
  }

  async save(snapshot: PageSnapshot): Promise<void> {
    const s = snapshot.toSnapshot();
    this.rows.set(s.sourceId, s);
  }
}

/** Links written as `<a href="url">title</a>`; a selector limits them to `<a class="selector">`. */
export class FakeLinkExtractor implements LinkExtractor {
  extract(html: string, pageUrl: string, linkSelector: string | null): ListingLink[] {
    const links: ListingLink[] = [];
    for (const m of html.matchAll(/<a( class="([^"]*)")? href="([^"]*)">([^<]*)<\/a>/g)) {
      if (linkSelector && m[2] !== linkSelector) continue;
      links.push({ url: new URL(m[3] ?? '', pageUrl).href, title: m[4] ?? '' });
    }
    return links;
  }
}

/** The page text is the HTML with tags removed, one line per line; no selector support. */
export class FakePageTextExtractor implements PageTextExtractor {
  extract(html: string): PageText {
    return {
      title: /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '',
      text: html.replace(/<title>[^<]*<\/title>/, '').replace(/<[^>]+>/g, ''),
    };
  }
}

/** Serves an HTML page at `url`. */
export function servePage(
  fetcher: StubPageFetcher,
  url: string,
  body: string,
  etag: string | null = null,
) {
  fetcher.responses.set(url, {
    status: 'ok',
    url,
    contentType: 'text/html',
    body,
    validators: { etag, lastModified: null },
  });
}

/** Everything CollectSource needs, as fakes sharing the given stores. */
export function collectSourceDeps(deps: {
  sources: InMemorySourceRepository;
  items: InMemoryItemRepository;
  fetcher: StubPageFetcher;
  contentStore: InMemoryItemContentStore;
  clock: { now(): Date };
  snapshots?: InMemoryPageSnapshotRepository;
}) {
  return {
    ...deps,
    snapshots: deps.snapshots ?? new InMemoryPageSnapshotRepository(),
    feedReader: new JsonFeedReader(),
    linkExtractor: new FakeLinkExtractor(),
    articleExtractor: new FakeArticleExtractor(),
    pageTextExtractor: new FakePageTextExtractor(),
  };
}
