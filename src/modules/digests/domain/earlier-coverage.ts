import { cosineSimilarity } from './clustering.ts';
import type { DigestEntry } from './digest-entry.ts';
import type { RunId } from './run-id.ts';
import type { EarlierCoverage, StoryCluster } from './story.ts';

/** An item an earlier published digest showed, with what it takes to recognise it again. */
export interface PublishedEntry {
  readonly runId: RunId;
  readonly itemId: string;
  readonly sourceName: string;
  readonly url: string;
  readonly title: string;
  readonly embedding: readonly number[];
}

export interface EarlierCoverageThresholds {
  /** At or above: a near-copy of an earlier item (a repost, a syndicated copy). */
  readonly repeat: number;
  /** At or above: the same story as an earlier item, possibly with news. */
  readonly followUp: number;
}

interface Match {
  readonly earlier: PublishedEntry;
  readonly similarity: number;
}

/**
 * Marks the stories that earlier digests already showed. A story is a repeat only when every
 * one of its items is a near-copy of an earlier item: one new article among reposts still
 * makes it news, so it becomes a follow-up instead. Hiding is reserved for near-copies;
 * anything merely similar stays visible, labelled, so nothing new is ever lost.
 */
export function markEarlierCoverage(
  clusters: readonly StoryCluster[],
  entries: readonly DigestEntry[],
  earlier: readonly PublishedEntry[],
  thresholds: EarlierCoverageThresholds,
): StoryCluster[] {
  if (earlier.length === 0) return [...clusters];
  const byId = new Map(entries.map((e) => [e.itemId, e]));

  return clusters.map((cluster) => {
    const matches = cluster.itemIds.map((id) => bestMatch(byId.get(id)?.embedding, earlier));
    const best = matches.reduce<Match | null>(
      (top, m) => (m && (!top || m.similarity > top.similarity) ? m : top),
      null,
    );
    if (!best || best.similarity < thresholds.followUp) return cluster;

    const allCopies = matches.every((m) => m !== null && m.similarity >= thresholds.repeat);
    return { ...cluster, earlier: coverage(allCopies ? 'repeat' : 'follow-up', best) };
  });
}

function bestMatch(
  embedding: readonly number[] | null | undefined,
  earlier: readonly PublishedEntry[],
): Match | null {
  if (!embedding) return null;
  let best: Match | null = null;
  for (const entry of earlier) {
    const similarity = cosineSimilarity(embedding, entry.embedding);
    // Ties: the older report, so a story points at where it first appeared
    if (
      !best ||
      similarity > best.similarity ||
      (similarity === best.similarity && entry.runId < best.earlier.runId)
    ) {
      best = { earlier: entry, similarity };
    }
  }
  return best;
}

function coverage(kind: EarlierCoverage['kind'], { earlier, similarity }: Match): EarlierCoverage {
  return {
    kind,
    runId: earlier.runId,
    sourceName: earlier.sourceName,
    title: earlier.title,
    url: earlier.url,
    similarity: Math.round(similarity * 1000) / 1000,
  };
}
