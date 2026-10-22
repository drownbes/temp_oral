import type { Source } from './source.ts';
import { canonicalizeUrl } from './url.ts';

type WithUrl = { readonly url: string };

/**
 * Canonicalises entry URLs (relative ones against `baseUrl`), drops non-http(s) ones and
 * keeps the first occurrence of each URL.
 */
export function uniqueEntries<T extends WithUrl>(entries: readonly T[], baseUrl: string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const entry of entries) {
    const url = canonicalizeUrl(entry.url, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({ ...entry, url });
  }
  return unique;
}

/**
 * On a source's first collection, posts this recent still count as new, so a source added
 * today shows up in today's digest; older ones are only remembered.
 */
export const FIRST_COLLECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PlannedEntry {
  /** Remembered but never handed to a digest. */
  readonly baseline: boolean;
}

export interface CollectionPlan<T> {
  /** Entries not seen before, with canonical URLs, each marked baseline or not. */
  readonly newEntries: readonly (T & PlannedEntry)[];
  /** The source's first collection: everything but recent posts becomes the baseline. */
  readonly firstCollection: boolean;
}

/**
 * Decides which discovered entries become new items; `knownUrls` are already stored. On the
 * first collection, entries without a date or older than the window are the baseline, so
 * day one isn't a flood of the archive.
 */
export function planCollection<T extends WithUrl & { readonly publishedAt?: Date | null }>(
  source: Source,
  entries: readonly T[],
  knownUrls: ReadonlySet<string>,
  now: Date,
): CollectionPlan<T> {
  const firstCollection = !source.isBaselined;
  const cutoff = now.getTime() - FIRST_COLLECTION_WINDOW_MS;
  const isBaseline = (entry: T) =>
    firstCollection && !(entry.publishedAt && entry.publishedAt.getTime() >= cutoff);
  return {
    newEntries: uniqueEntries(entries, source.url)
      .filter((e) => !knownUrls.has(e.url))
      .map((e) => ({ ...e, baseline: isBaseline(e) })),
    firstCollection,
  };
}
