import type { ItemContentKeys, ItemId, ItemSnapshot } from '../domain/item.ts';
import type { RunId } from '../domain/run-id.ts';
import type { FetchValidators, SourceId } from '../domain/source.ts';

export interface FetchRequest {
  readonly url: string;
  /** Sent as If-None-Match / If-Modified-Since. */
  readonly validators: FetchValidators;
  /** Browser fetchers: read the page once this CSS selector matches. Others ignore it. */
  readonly waitForSelector?: string | null;
}

export type FetchResult =
  | { readonly status: 'not-modified' }
  | {
      readonly status: 'ok';
      /** After redirects. */
      readonly url: string;
      readonly contentType: string;
      readonly body: string;
      readonly validators: FetchValidators;
    };

/**
 * Port: downloads a page. Throws SourceFetchError for permanent failures (4xx, blocked
 * address, too large); any other error is treated as transient and retried.
 */
export interface PageFetcher {
  fetch(request: FetchRequest): Promise<FetchResult>;
}

export interface FeedEntry {
  /** Absolute, as found in the feed (not yet canonical). */
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  /** Entry content as published (full content if present, otherwise the summary). */
  readonly html: string;
  /** Readable plain text of `html`. */
  readonly text: string;
}

/** Port: parses RSS / Atom / RDF / JSON Feed. Throws InvalidFeedError when it is not a feed. */
export interface FeedReader {
  read(body: string, baseUrl: string): FeedEntry[];
}

export interface ItemContentLocation {
  readonly sourceId: SourceId;
  readonly runId: RunId;
  readonly itemId: ItemId;
}

/** Port: raw and extracted content of items (S3 in production). Writes are idempotent. */
export interface ItemContentStore {
  put(
    location: ItemContentLocation,
    content: { readonly html: string; readonly text: string },
  ): Promise<ItemContentKeys>;
  readText(key: string): Promise<string>;
}

export interface ExportLine {
  readonly item: ItemSnapshot;
  readonly sourceName: string;
  readonly text: string;
}

/** Port: publishes a run's items for the digest (the claim-check file). Returns its key. */
export interface ItemExporter {
  write(runId: RunId, lines: readonly ExportLine[]): Promise<string>;
}

/** Port: starts a collection run asynchronously (a Temporal workflow in production). */
export interface CollectionStarter {
  start(runId: RunId): Promise<{ readonly workflowId: string }>;
}

export interface ExtractedArticle {
  readonly title: string;
  /** The article body only (no navigation, ads, comments). */
  readonly html: string;
  readonly text: string;
}

/** Port: pulls the readable article out of a full web page; undefined if there is none. */
export interface ArticleExtractor {
  extract(html: string, url: string): ExtractedArticle | undefined;
}

export interface ListingLink {
  /** Absolute (resolved against the page), not yet canonical. */
  readonly url: string;
  /** The link text; may be empty (image links). */
  readonly title: string;
}

/** Port: links of a listing page, optionally limited to elements matching a CSS selector. */
export interface LinkExtractor {
  extract(html: string, pageUrl: string, linkSelector: string | null): ListingLink[];
}

export interface PageText {
  readonly title: string;
  readonly text: string;
}

/** Port: the readable text of a page, or of the part matching a CSS selector. */
export interface PageTextExtractor {
  extract(html: string, url: string, contentSelector: string | null): PageText;
}
