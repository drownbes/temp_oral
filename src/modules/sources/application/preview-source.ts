import { isListingArticle, wantsArticlePage } from '../domain/article.ts';
import { uniqueEntries } from '../domain/collection.ts';
import { InvalidSourceError } from '../domain/errors.ts';
import { normalizePageText } from '../domain/page-watch.ts';
import type { FetchMode, SourceKind, SourceSettingsInput } from '../domain/source.ts';
import { sourceSettings } from '../domain/source.ts';
import { canonicalizeUrl } from '../domain/url.ts';
import { fetchArticle } from './article-content.ts';
import type {
  ArticleExtractor,
  FeedReader,
  LinkExtractor,
  PageFetcher,
  PageTextExtractor,
} from './ports.ts';
import { assertSupported } from './supported-sources.ts';

export interface PreviewSourceCommand extends SourceSettingsInput {
  readonly url: string;
  readonly kind: SourceKind;
  readonly fetchMode: FetchMode;
}

export interface PreviewEntry {
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly excerpt: string;
}

/** What article fetching makes of the first entry (teaser feeds, listings). */
export type ArticleSample =
  | {
      readonly url: string;
      readonly feedChars: number;
      readonly articleChars: number;
      readonly excerpt: string;
    }
  | { readonly url: string; readonly error: string };

/** What a watched page's text looks like with the given selector. */
export interface PageSample {
  readonly title: string;
  readonly chars: number;
  readonly lines: number;
  readonly excerpt: string;
}

export interface SourcePreview {
  /** After redirects. */
  readonly url: string;
  /** Feed entries, or listing links that pass the selector and pattern. */
  readonly entryCount: number;
  readonly entries: readonly PreviewEntry[];
  /** Null when no article would be fetched (full-text feed, disabled, page watch). */
  readonly articleSample: ArticleSample | null;
  /** Page watch only. */
  readonly pageSample: PageSample | null;
}

export interface PreviewSourceDeps {
  readonly fetcher: PageFetcher;
  readonly feedReader: FeedReader;
  readonly linkExtractor: LinkExtractor;
  readonly articleExtractor: ArticleExtractor;
  readonly pageTextExtractor: PageTextExtractor;
}

const MAX_ENTRIES = 20;
const EXCERPT_LENGTH = 300;
const PAGE_EXCERPT_LENGTH = 1000;

/** Fetches and extracts a source without storing anything, to check its configuration. */
export class PreviewSource {
  readonly #deps: PreviewSourceDeps;

  constructor(deps: PreviewSourceDeps) {
    this.#deps = deps;
  }

  async execute(command: PreviewSourceCommand): Promise<SourcePreview> {
    const { fetcher, feedReader, linkExtractor, articleExtractor, pageTextExtractor } = this.#deps;
    const settings = sourceSettings(command.kind, command);
    assertSupported(settings.kind, command.fetchMode);
    const url = canonicalizeUrl(command.url);
    if (!url) throw new InvalidSourceError('url must be an absolute http(s) URL');

    const page = await fetcher.fetch({ url, validators: { etag: null, lastModified: null } });
    if (page.status !== 'ok') throw new Error('unconditional fetch returned not-modified');

    if (settings.kind === 'page') {
      const extracted = pageTextExtractor.extract(page.body, page.url, settings.contentSelector);
      const text = normalizePageText(extracted.text);
      return {
        url: page.url,
        entryCount: 0,
        entries: [],
        articleSample: null,
        pageSample: {
          title: extracted.title,
          chars: text.length,
          lines: text ? text.split('\n').length : 0,
          excerpt: text.slice(0, PAGE_EXCERPT_LENGTH),
        },
      };
    }

    const entries =
      settings.kind === 'feed'
        ? feedReader.read(page.body, page.url)
        : uniqueEntries(
            linkExtractor
              .extract(page.body, page.url, settings.linkSelector)
              .filter((link) => isListingArticle(link.url, page.url, settings.urlPattern))
              .map((link) => ({ ...link, publishedAt: null, text: '' })),
            page.url,
          );

    const [first] = entries;
    let articleSample: ArticleSample | null = null;
    if (first && wantsArticlePage(settings, first.text, false)) {
      const article = await fetchArticle({ fetcher, extractor: articleExtractor }, first.url);
      articleSample = article.ok
        ? {
            url: first.url,
            feedChars: first.text.length,
            articleChars: article.text.length,
            excerpt: article.text.slice(0, EXCERPT_LENGTH),
          }
        : { url: first.url, error: article.reason };
    }
    return {
      url: page.url,
      entryCount: entries.length,
      entries: entries.slice(0, MAX_ENTRIES).map((e) => ({
        url: e.url,
        title: e.title,
        publishedAt: e.publishedAt,
        excerpt: e.text.slice(0, EXCERPT_LENGTH),
      })),
      articleSample,
      pageSample: null,
    };
  }
}
