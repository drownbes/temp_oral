import type { Clock } from '#shared/kernel/clock.ts';
import { prefersArticleText, wantsArticlePage } from '../domain/article.ts';
import { planCollection, uniqueEntries } from '../domain/collection.ts';
import { SourceNotFoundError } from '../domain/errors.ts';
import { Item, itemIdFor } from '../domain/item.ts';
import type { ItemRepository } from '../domain/item-repository.ts';
import { parseRunId } from '../domain/run-id.ts';
import type { SourceId } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';
import { type ArticleFetch, fetchArticle } from './article-content.ts';
import { mapConcurrent } from './concurrency.ts';
import type { ArticleExtractor, FeedReader, ItemContentStore, PageFetcher } from './ports.ts';

export interface CollectSourceResult {
  readonly sourceId: SourceId;
  readonly status: 'collected' | 'not-modified' | 'skipped';
  readonly newItems: number;
  /** True on the source's first collection: items were recorded but won't be exported. */
  readonly baseline: boolean;
  /** New items whose text came from their own page instead of the feed's teaser. */
  readonly articlesFetched: number;
  /** Article pages that could not be fetched or read; those items kept the feed text. */
  readonly articleFailures: number;
}

export interface CollectSourceDeps {
  readonly sources: SourceRepository;
  readonly items: ItemRepository;
  readonly fetcher: PageFetcher;
  readonly feedReader: FeedReader;
  readonly articleExtractor: ArticleExtractor;
  readonly contentStore: ItemContentStore;
  readonly clock: Clock;
}

const NOTHING_NEW = { newItems: 0, baseline: false, articlesFetched: 0, articleFailures: 0 };
const CONTENT_WRITE_CONCURRENCY = 8;
/** Be gentle with the site: few article pages at a time, and a cap per run. */
const ARTICLE_FETCH_CONCURRENCY = 2;
const MAX_ARTICLE_FETCHES = 30;

/**
 * Fetches a source and stores what is new, with each new article's own text where the feed
 * only has a teaser. Idempotent, because it runs as a Temporal activity: item ids are
 * deterministic, content writes overwrite, and inserts skip known ids.
 * Failures are not recorded here; the workflow records them once retries are exhausted.
 */
export class CollectSource {
  readonly #deps: CollectSourceDeps;

  constructor(deps: CollectSourceDeps) {
    this.#deps = deps;
  }

  async execute(sourceId: SourceId, rawRunId: string): Promise<CollectSourceResult> {
    const { sources, items, fetcher, feedReader, articleExtractor, contentStore, clock } =
      this.#deps;
    const runId = parseRunId(rawRunId);
    const source = await sources.findById(sourceId);
    if (!source) throw new SourceNotFoundError(sourceId);
    if (!source.isCollectable) return { sourceId, status: 'skipped', ...NOTHING_NEW };

    const { validators } = source.toSnapshot();
    const page = await fetcher.fetch({ url: source.url, validators });
    if (page.status === 'not-modified') {
      source.recordSuccess(validators, clock.now());
      await sources.save(source);
      return { sourceId, status: 'not-modified', ...NOTHING_NEW };
    }

    const entries = uniqueEntries(feedReader.read(page.body, page.url), source.url);
    const known = await items.knownUrls(
      sourceId,
      entries.map((e) => e.url),
    );
    const plan = planCollection(source, entries, known);

    const toFetch = plan.newEntries
      .filter((e) => wantsArticlePage(source.toSnapshot().settings, e.text, plan.baseline))
      .slice(0, MAX_ARTICLE_FETCHES);
    const articles = new Map<string, ArticleFetch>(
      await mapConcurrent(toFetch, ARTICLE_FETCH_CONCURRENCY, async (entry) => {
        const article = await fetchArticle({ fetcher, extractor: articleExtractor }, entry.url);
        return [entry.url, article] as const;
      }),
    );

    // Content first: a stored item must always have its objects
    const newItems = await mapConcurrent(
      plan.newEntries,
      CONTENT_WRITE_CONCURRENCY,
      async (entry) => {
        const itemId = await itemIdFor(sourceId, entry.url);
        const article = articles.get(entry.url);
        const content =
          article?.ok && prefersArticleText(entry.text, article.text)
            ? { html: article.pageHtml, text: article.text }
            : { html: entry.html, text: entry.text };
        const keys = await contentStore.put({ sourceId, runId, itemId }, content);
        return Item.discover({
          id: itemId,
          sourceId,
          url: entry.url,
          title: entry.title,
          publishedAt: entry.publishedAt,
          baseline: plan.baseline,
          content: keys,
          now: clock.now(),
        });
      },
    );
    await items.addNew(newItems);

    source.recordSuccess(page.validators, clock.now());
    await sources.save(source);
    const fetched = [...articles.values()];
    return {
      sourceId,
      status: 'collected',
      newItems: newItems.length,
      baseline: plan.baseline,
      articlesFetched: fetched.filter((a) => a.ok).length,
      articleFailures: fetched.filter((a) => !a.ok).length,
    };
  }
}
