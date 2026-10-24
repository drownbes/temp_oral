import type { Clock } from '#shared/kernel/clock.ts';
import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type {
  DigestEntryRepository,
  DigestRepository,
  InterestProfileRepository,
} from '../domain/repositories.ts';
import { digestPageOf } from './digest-page.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { DigestPublisher } from './ports.ts';

export interface PublishDigestDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly profiles: InterestProfileRepository;
  readonly publisher: DigestPublisher;
  readonly clock: Clock;
}

/**
 * Ranks the stories and publishes the page. Every day goes into the archive, but a digest
 * finishing after a newer day was published (its batch was slow) is superseded: it does not
 * replace the "latest" page.
 */
export class PublishDigest {
  readonly #deps: PublishDigestDeps;

  constructor(deps: PublishDigestDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, publisher, clock } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    if (digest.status !== 'rendering') return toState(digest);
    const snapshot = digest.toSnapshot();

    const latest = await digests.latestPublishedRunId(snapshot.ownerId);
    const superseded = latest !== undefined && latest > snapshot.runId;

    await publisher.publish(await digestPageOf(this.#deps, snapshot, clock.now()), {
      latest: !superseded,
    });
    if (superseded) digest.supersede(clock.now());
    else digest.publish(clock.now());
    await digests.save(digest);
    return toState(digest);
  }
}
