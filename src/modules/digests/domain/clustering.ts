import type { DigestEntry } from './digest-entry.ts';
import type { StoryCluster } from './story.ts';

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

const relevance = (e: DigestEntry) => e.analysis?.relevance ?? -1;

/** Most relevant first; ties broken by id, so the same input always clusters the same way. */
const leadFirst = (a: DigestEntry, b: DigestEntry) =>
  relevance(b) - relevance(a) || a.itemId.localeCompare(b.itemId);

/**
 * Greedy grouping: the most relevant unassigned item starts a story and takes, from each
 * other source, the unassigned item most similar to it, if at least `threshold` similar.
 *
 * - One item per source: a site rarely covers the same story twice, while its articles on
 *   the same topic (two filesystem updates for one kernel release) embed very close
 *   together. Without this rule stories turn into topics.
 * - Compared to the lead only (not to every member), so stories don't drift into themes.
 * - Items without an embedding stay alone.
 */
export function clusterEntries(entries: readonly DigestEntry[], threshold: number): StoryCluster[] {
  const ordered = [...entries].sort(leadFirst);
  const assigned = new Set<string>();
  const clusters: StoryCluster[] = [];

  for (const lead of ordered) {
    if (assigned.has(lead.itemId)) continue;
    assigned.add(lead.itemId);
    const members = [lead];
    const leadEmbedding = lead.embedding;
    if (leadEmbedding) {
      const candidates = ordered
        .filter((e) => !assigned.has(e.itemId) && e.embedding && e.sourceId !== lead.sourceId)
        .map((e) => ({ entry: e, similarity: cosineSimilarity(leadEmbedding, e.embedding ?? []) }))
        .filter((c) => c.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity);
      const sources = new Set([lead.sourceId]);
      for (const { entry } of candidates) {
        if (sources.has(entry.sourceId)) continue;
        sources.add(entry.sourceId);
        assigned.add(entry.itemId);
        members.push(entry);
      }
    }
    clusters.push({
      id: lead.itemId,
      itemIds: members.map((m) => m.itemId),
      headline: null,
      summary: null,
    });
  }
  return clusters;
}
