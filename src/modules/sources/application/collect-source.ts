import type { Clock } from '#shared/kernel/clock.ts';
import {
  isListingArticle,
  listingItemTitle,
  prefersArticleText,
  wantsArticlePage,
} from '../domain/article.ts';
import { planCollection, uniqueEntries } from '../domain/collection.ts';
import { SourceNotFoundError } from '../domain/errors.ts';
import { Item, itemIdFor } from '../domain/item.ts';
import type { ItemRepository } from '../domain/item-repository.ts';
import {
  changeItemUrl,
  changeText,
  contentHash,
  describeChange,
  normalizePageText,
  PageSnapshot,
} from '../domain/page-watch.ts';
import { parseRunId, type RunId } from '../domain/run-id.ts';
import type { Source, SourceId } from '../domain/source.ts';
import type { PageSnapshotRepository, SourceRepository } from '../domain/source-repository.ts';
import { isYouTubeShort, videoText } from '../domain/youtube.ts';
import { type ArticleFetch, fetchArticle } from './article-content.ts';
import { mapConcurrent } from './concurrency.ts';
import type {
  ArticleExtractor,
  FeedReader,
  ItemContentStore,
  LinkExtractor,
  PageFetcher,
  PageTextExtractor,
  VideoTranscripts,
} from './ports.ts';
import { fetchTranscript, type TranscriptFetch } from './youtube-videos.ts';

export interface CollectSourceResult {
  readonly sourceId: SourceId;
  readonly status: 'collected' | 'not-modified' | 'skipped';
  readonly newItems: number;
  /** True on the source's first collection: only posts of the last 24 hours are exported. */
  readonly baseline: boolean;
  /** Article pages fetched and read (feed teasers replaced, listing articles collected). */
  readonly articlesFetched: number;
  /** Article pages that could not be fetched or read. */
  readonly articleFailures: number;
  /** YouTube videos stored with their transcript. */
  readonly transcriptsFetched: number;
  /** YouTube videos stored with their description only (no captions, or unreadable). */
  readonly transcriptsMissing: number;
}

export interface CollectSourceDeps {
  readonly sources: SourceRepository;
  readonly items: ItemRepository;
  readonly snapshots: PageSnapshotRepository;
  readonly fetcher: PageFetcher;
  readonly feedReader: FeedReader;
  readonly linkExtractor: LinkExtractor;
  readonly articleExtractor: ArticleExtractor;
  readonly pageTextExtractor: PageTextExtractor;
  readonly transcripts: VideoTranscripts;
  readonly contentStore: ItemContentStore;
  readonly clock: Clock;
}

interface Entry {
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly html: string;
  readonly text: string;
}

type Outcome = Omit<CollectSourceResult, 'sourceId' | 'status'>;

const NOTHING_NEW: Outcome = {
  newItems: 0,
  baseline: false,
  articlesFetched: 0,
  articleFailures: 0,
  transcriptsFetched: 0,
  transcriptsMissing: 0,
};
const CONTENT_WRITE_CONCURRENCY = 8;
/** Be gentle with the site: few article pages at a time, and a cap per run. */
const ARTICLE_FETCH_CONCURRENCY = 2;
const MAX_ARTICLE_FETCHES = 30;
/** The channel feed lists 15 videos at most, so there is no cap. */
const TRANSCRIPT_FETCH_CONCURRENCY = 2;
/** Watched pages are compared as text; beyond this they are cut. */
const MAX_PAGE_TEXT_CHARS = 200_000;

/**
 * Fetches a source and stores what is new:
 * - feed: new entries, with each article's own text where the feed only has a teaser;
 * - listing: new article links, each with its page's text (failed ones are retried next run);
 * - page: one 'change' item when the watched page's text changed since the last snapshot;
 * - youtube: new videos of the channel's feed (not Shorts), each with its transcript.
 * Idempotent, because it runs as a Temporal activity: item ids are deterministic, content
 * writes overwrite, and inserts skip known ids. Failures are not recorded here; the workflow
 * records them once retries are exhausted.
 */
export class CollectSource {
  readonly #deps: CollectSourceDeps;

  constructor(deps: CollectSourceDeps) {
    this.#deps = deps;
  }

  async execute(sourceId: SourceId, rawRunId: string): Promise<CollectSourceResult> {
    const { sources, fetcher, feedReader, linkExtractor, clock } = this.#deps;
    const runId = parseRunId(rawRunId);
    const source = await sources.findById(sourceId);
    if (!source) throw new SourceNotFoundError(sourceId);
    if (!source.isCollectable) return { sourceId, status: 'skipped', ...NOTHING_NEW };

    const { validators, settings, waitForSelector } = source.toSnapshot();
    const page = await fetcher.fetch({ url: source.fetchUrl, validators, waitForSelector });
    if (page.status === 'not-modified') {
      source.recordSuccess(validators, clock.now());
      await sources.save(source);
      return { sourceId, status: 'not-modified', ...NOTHING_NEW };
    }

    let outcome: Outcome;
    switch (settings.kind) {
      case 'feed':
        outcome = await this.#storeNew(source, runId, feedReader.read(page.body, page.url));
        break;
      case 'listing': {
        const links = linkExtractor
          .extract(page.body, page.url, settings.linkSelector)
          .filter((link) => isListingArticle(link.url, page.url, settings.urlPattern))
          .map((link) => ({ ...link, publishedAt: null, html: '', text: '' }));
        outcome = await this.#storeNew(source, runId, links);
        break;
      }
      case 'page':
        outcome = await this.#watchPage(source, runId, page.body, settings.contentSelector);
        break;
      case 'youtube': {
        const videos = feedReader.read(page.body, page.url).filter((e) => !isYouTubeShort(e.url));
        outcome = await this.#storeNew(source, runId, videos);
        break;
      }
    }

    source.recordSuccess(page.validators, clock.now());
    await sources.save(source);
    return { sourceId, status: 'collected', ...outcome };
  }

  /**
   * Feeds, listings and channels: store unseen entries, with their article's text or their
   * video's transcript where wanted.
   */
  async #storeNew(source: Source, runId: RunId, discovered: readonly Entry[]): Promise<Outcome> {
    const { items, fetcher, articleExtractor, transcripts, contentStore, clock } = this.#deps;
    const { settings } = source.toSnapshot();
    const entries = uniqueEntries(discovered, source.url);
    const known = await items.knownUrls(
      source.id,
      entries.map((e) => e.url),
    );
    const plan = planCollection(source, entries, known, clock.now());

    const toFetch = plan.newEntries
      .filter((e) => wantsArticlePage(settings, e.text, e.baseline))
      .slice(0, MAX_ARTICLE_FETCHES);
    const articles = new Map<string, ArticleFetch>(
      await mapConcurrent(toFetch, ARTICLE_FETCH_CONCURRENCY, async (entry) => {
        const article = await fetchArticle({ fetcher, extractor: articleExtractor }, entry.url);
        return [entry.url, article] as const;
      }),
    );
    // Baseline videos are never handed to a digest, so they need no transcript
    const toTranscribe =
      settings.kind === 'youtube' ? plan.newEntries.filter((e) => !e.baseline) : [];
    const videoTranscripts = new Map<string, TranscriptFetch>(
      await mapConcurrent(toTranscribe, TRANSCRIPT_FETCH_CONCURRENCY, async (entry) => {
        return [entry.url, await fetchTranscript(transcripts, entry.url)] as const;
      }),
    );

    // A listing link is only worth storing with its article; the rest (over the cap, or
    // failed) is retried next run. Feed entries always have their own text.
    const toStore = plan.newEntries.filter(
      (e) => settings.kind !== 'listing' || e.baseline || articles.get(e.url)?.ok,
    );

    // Content first: a stored item must always have its objects
    const newItems = await mapConcurrent(toStore, CONTENT_WRITE_CONCURRENCY, async (entry) => {
      const itemId = await itemIdFor(source.id, entry.url);
      const article = articles.get(entry.url);
      const useArticle = article?.ok && prefersArticleText(entry.text, article.text);
      const transcript = videoTranscripts.get(entry.url);
      const content = useArticle
        ? { html: article.pageHtml, text: article.text }
        : {
            html: entry.html,
            text: transcript?.ok ? videoText(entry.text, transcript.text) : entry.text,
          };
      const keys = await contentStore.put({ sourceId: source.id, runId, itemId }, content);
      return Item.discover({
        id: itemId,
        sourceId: source.id,
        url: entry.url,
        // A feed's title is its own headline; a listing link may be a whole card
        title:
          settings.kind === 'listing'
            ? listingItemTitle(entry.title, article?.ok ? article.title : '')
            : entry.title || (article?.ok ? article.title : ''),
        publishedAt: entry.publishedAt,
        baseline: entry.baseline,
        content: keys,
        now: clock.now(),
      });
    });
    await items.addNew(newItems);

    const fetched = [...articles.values()];
    const transcribed = [...videoTranscripts.values()];
    return {
      newItems: newItems.length,
      baseline: plan.firstCollection,
      articlesFetched: fetched.filter((a) => a.ok).length,
      articleFailures: fetched.filter((a) => !a.ok).length,
      transcriptsFetched: transcribed.filter((t) => t.ok).length,
      transcriptsMissing: transcribed.filter((t) => !t.ok).length,
    };
  }

  /**
   * Watched page: the first version (or the first after the URL changed) is the baseline;
   * after that each new version becomes one 'change' item describing what changed.
   */
  async #watchPage(
    source: Source,
    runId: RunId,
    html: string,
    contentSelector: string | null,
  ): Promise<Outcome> {
    const { items, snapshots, pageTextExtractor, contentStore, clock } = this.#deps;
    const { name, url } = source.toSnapshot();
    const page = pageTextExtractor.extract(html, url, contentSelector);
    const text = normalizePageText(page.text).slice(0, MAX_PAGE_TEXT_CHARS);
    const hash = await contentHash(text);
    const now = clock.now();
    const current = PageSnapshot.take({
      sourceId: source.id,
      url,
      contentHash: hash,
      text,
      takenAt: now,
    });

    const previous = await snapshots.find(source.id);
    if (!previous?.isOf(url)) {
      await snapshots.save(current);
      return { ...NOTHING_NEW, baseline: true };
    }
    if (!previous.changedTo(url, hash)) return NOTHING_NEW;

    const change = describeChange(previous.toSnapshot().text, text);
    const itemUrl = changeItemUrl(url, hash);
    const itemId = await itemIdFor(source.id, itemUrl);
    const title = `${page.title || name}: page changed`;
    const keys = await contentStore.put(
      { sourceId: source.id, runId, itemId },
      { html, text: `${title}\n\n${changeText(change)}` },
    );
    // Item before snapshot: if we crash in between, the next run finds the same change
    // again, and the same deterministic id makes storing it a no-op
    await items.addNew([
      Item.discover({
        id: itemId,
        kind: 'change',
        sourceId: source.id,
        url: itemUrl,
        title,
        publishedAt: now,
        baseline: false,
        content: keys,
        now,
      }),
    ]);
    await snapshots.save(current);
    return { ...NOTHING_NEW, newItems: 1 };
  }
}
