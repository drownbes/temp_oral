import type { DigestSnapshot } from '../domain/digest.ts';
import type { DigestEntry } from '../domain/digest-entry.ts';
import { type Story, singleStories, toStories } from '../domain/ranking.ts';
import type { StoryItem } from './ports.ts';

/** The digest's stories; a digest that was never clustered shows each item on its own. */
export function storiesOf(digest: DigestSnapshot, entries: readonly DigestEntry[]): Story[] {
  const clusters = digest.clusters.length > 0 ? digest.clusters : singleStories(entries);
  return toStories(clusters, entries);
}

export function storyItem(entry: DigestEntry): StoryItem {
  return {
    sourceName: entry.sourceName,
    title: entry.title,
    summary: entry.analysis?.summary ?? entry.title,
  };
}
