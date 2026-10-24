import type { DigestSnapshot } from '../domain/digest.ts';
import { DEFAULT_RELEVANCE_THRESHOLD } from '../domain/interest-profile.ts';
import { rankStories } from '../domain/ranking.ts';
import type { DigestEntryRepository, InterestProfileRepository } from '../domain/repositories.ts';
import type { DigestPage } from './ports.ts';
import { storiesOf } from './stories.ts';

export interface DigestPageDeps {
  readonly entries: DigestEntryRepository;
  readonly profiles: InterestProfileRepository;
}

/** What the page shows: the digest's stories, ranked with the owner's current threshold. */
export async function digestPageOf(
  { entries, profiles }: DigestPageDeps,
  snapshot: DigestSnapshot,
  generatedAt: Date,
): Promise<DigestPage> {
  const profile = await profiles.find(snapshot.ownerId);
  const threshold = profile?.toSnapshot().relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const ranked = rankStories(
    storiesOf(snapshot, await entries.listByDigest(snapshot.id)),
    threshold,
  );
  return {
    runId: snapshot.runId,
    generatedAt,
    overview: snapshot.overview,
    ...ranked,
    failedSources: snapshot.failedSources,
    itemCount: snapshot.itemCount,
    analyzedCount: snapshot.analyzedCount,
    failedItemCount: snapshot.failedItemCount,
    usage: snapshot.usage,
  };
}
