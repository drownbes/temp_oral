import type { DigestEntry } from './digest-entry.ts';
import type { StoryCluster } from './story.ts';

/** A story with its items resolved: what the page shows as one entry. */
export interface Story {
  readonly cluster: StoryCluster;
  /** Lead item first. */
  readonly entries: readonly DigestEntry[];
  /** The best relevance among its items; -1 if none was analysed. */
  readonly relevance: number;
}

export interface RankedStories {
  /** Relevant stories, most relevant first: shown with their summaries. */
  readonly featured: readonly Story[];
  /** Everything else, newest first: shown as headlines only. */
  readonly alsoNoted: readonly Story[];
}

/** Keeps the page readable on busy days; the rest still appears as headlines. */
export const MAX_FEATURED = 25;

const newest = (story: Story) =>
  Math.max(...story.entries.map((e) => e.publishedAt?.getTime() ?? 0));

const newestFirst = (a: Story, b: Story) =>
  newest(b) - newest(a) || a.cluster.id.localeCompare(b.cluster.id);

/** Each entry as its own story: for digests without clusters (nothing to group). */
export function singleStories(entries: readonly DigestEntry[]): StoryCluster[] {
  return entries.map((e) => ({ id: e.itemId, itemIds: [e.itemId], headline: null, summary: null }));
}

export function toStories(
  clusters: readonly StoryCluster[],
  entries: readonly DigestEntry[],
): Story[] {
  const byId = new Map(entries.map((e) => [e.itemId, e]));
  return clusters.flatMap((cluster) => {
    const members = cluster.itemIds.flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    });
    if (members.length === 0) return [];
    const relevance = Math.max(...members.map((e) => e.analysis?.relevance ?? -1));
    return [{ cluster, entries: members, relevance }];
  });
}

export function rankStories(stories: readonly Story[], threshold: number): RankedStories {
  const relevant = stories
    .filter((s) => s.relevance >= threshold)
    .sort((a, b) => b.relevance - a.relevance || newestFirst(a, b));
  const featured = relevant.slice(0, MAX_FEATURED);
  const featuredIds = new Set(featured.map((s) => s.cluster.id));
  return {
    featured,
    alsoNoted: stories.filter((s) => !featuredIds.has(s.cluster.id)).sort(newestFirst),
  };
}
