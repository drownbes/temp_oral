import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError, InvalidDigestStateError } from '../domain/errors.ts';
import type {
  DigestEntryRepository,
  DigestRepository,
  InterestProfileRepository,
} from '../domain/repositories.ts';
import { digestPageOf } from './digest-page.ts';
import type { DigestPublisher } from './ports.ts';

export interface RepublishDigestDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly profiles: InterestProfileRepository;
  readonly publisher: DigestPublisher;
}

export interface RepublishedDigest {
  readonly runId: string;
  /** Where the day's archived page is. */
  readonly location: string;
  /** Whether it also replaced the "latest" page (only the newest published day does). */
  readonly latest: boolean;
}

/**
 * Renders a finished digest again from what is stored and publishes it, e.g. after the page
 * changed or to fill the archive with days published before it existed. No LLM calls, and
 * the digest itself is left as it is. Ranking uses the owner's current relevance threshold.
 */
export class RepublishDigest {
  readonly #deps: RepublishDigestDeps;

  constructor(deps: RepublishDigestDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<RepublishedDigest> {
    const { digests, publisher } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    if (!digest.isFinished) {
      throw new InvalidDigestStateError(
        `cannot republish digest ${digestId}: it is ${digest.status}, not finished`,
      );
    }
    const snapshot = digest.toSnapshot();
    const latest =
      snapshot.status === 'published' &&
      (await digests.latestPublishedRunId(snapshot.ownerId)) === snapshot.runId;
    // The page keeps the time the digest was first finished
    const generatedAt = snapshot.publishedAt ?? snapshot.updatedAt;

    const location = await publisher.publish(
      await digestPageOf(this.#deps, snapshot, generatedAt),
      { latest },
    );
    return { runId: snapshot.runId, location, latest };
  }
}
