import type { Clock } from '#shared/kernel/clock.ts';
import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import { DEFAULT_RELEVANCE_THRESHOLD } from '../domain/interest-profile.ts';
import { rankStories } from '../domain/ranking.ts';
import type {
  DigestEntryRepository,
  DigestRepository,
  InterestProfileRepository,
} from '../domain/repositories.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { DigestPublisher } from './ports.ts';
import { storiesOf } from './stories.ts';

export interface PublishDigestDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly profiles: InterestProfileRepository;
  readonly publisher: DigestPublisher;
  readonly clock: Clock;
}

/**
 * Ranks the stories and publishes the page. There is a single "latest" page, so a digest
 * finishing after a newer day was published (its batch was slow) is superseded instead.
 */
export class PublishDigest {
  readonly #deps: PublishDigestDeps;

  constructor(deps: PublishDigestDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, entries, profiles, publisher, clock } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    if (digest.status !== 'rendering') return toState(digest);
    const snapshot = digest.toSnapshot();

    const latest = await digests.latestPublishedRunId(snapshot.ownerId);
    if (latest && latest > snapshot.runId) {
      digest.supersede(clock.now());
      await digests.save(digest);
      return toState(digest);
    }

    const profile = await profiles.find(snapshot.ownerId);
    const threshold = profile?.toSnapshot().relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
    const ranked = rankStories(
      storiesOf(snapshot, await entries.listByDigest(digestId)),
      threshold,
    );

    await publisher.publish({
      runId: snapshot.runId,
      generatedAt: clock.now(),
      overview: snapshot.overview,
      ...ranked,
      failedSources: snapshot.failedSources,
      itemCount: snapshot.itemCount,
      analyzedCount: snapshot.analyzedCount,
      failedItemCount: snapshot.failedItemCount,
    });
    digest.publish(clock.now());
    await digests.save(digest);
    return toState(digest);
  }
}
