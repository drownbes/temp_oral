import type { Clock } from '#shared/kernel/clock.ts';
import type { CollectionOutcome, DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository } from '../domain/repositories.ts';
import { type DigestState, toState } from './digest-state.ts';

export interface RecordCollectionDeps {
  readonly digests: DigestRepository;
  readonly clock: Clock;
}

/** Stores what the collection run produced. Idempotent: a retry after saving is a no-op. */
export class RecordCollection {
  readonly #deps: RecordCollectionDeps;

  constructor(deps: RecordCollectionDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId, outcome: CollectionOutcome): Promise<DigestState> {
    const digest = await this.#deps.digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    if (digest.status === 'collecting') {
      digest.recordCollection(outcome, this.#deps.clock.now());
      await this.#deps.digests.save(digest);
    }
    return toState(digest);
  }
}
