import type { DigestEntry } from './digest-entry.ts';

export interface RankedEntries {
  /** Relevant items, most relevant first: shown with their summaries. */
  readonly featured: readonly DigestEntry[];
  /** Everything else, newest first: shown as headlines only. */
  readonly alsoNoted: readonly DigestEntry[];
}

/** Keeps the page readable on busy days; the rest still appears as headlines. */
export const MAX_FEATURED = 25;

const newestFirst = (a: DigestEntry, b: DigestEntry) =>
  (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) ||
  a.title.localeCompare(b.title);

export function rankForDigest(entries: readonly DigestEntry[], threshold: number): RankedEntries {
  const relevant = entries
    .filter((e) => e.analysis && e.analysis.relevance >= threshold)
    .sort(
      (a, b) => (b.analysis?.relevance ?? 0) - (a.analysis?.relevance ?? 0) || newestFirst(a, b),
    );
  const featured = relevant.slice(0, MAX_FEATURED);
  const featuredIds = new Set(featured.map((e) => e.itemId));
  return {
    featured,
    alsoNoted: entries.filter((e) => !featuredIds.has(e.itemId)).sort(newestFirst),
  };
}
