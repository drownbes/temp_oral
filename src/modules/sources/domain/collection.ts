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

export interface CollectionPlan<T> {
  /** Entries not seen before, with canonical URLs. */
  readonly newEntries: readonly T[];
  /** The source's first collection only records what is there, so day one isn't a flood. */
  readonly baseline: boolean;
}

/** Decides which discovered entries become new items; `knownUrls` are already stored. */
export function planCollection<T extends WithUrl>(
  source: Source,
  entries: readonly T[],
  knownUrls: ReadonlySet<string>,
): CollectionPlan<T> {
  return {
    newEntries: uniqueEntries(entries, source.url).filter((e) => !knownUrls.has(e.url)),
    baseline: !source.isBaselined,
  };
}
