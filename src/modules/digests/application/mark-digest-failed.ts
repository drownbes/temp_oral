import type { Clock } from '#shared/kernel/clock.ts';
import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository } from '../domain/repositories.ts';

export interface MarkDigestFailedDeps {
  readonly digests: DigestRepository;
  readonly clock: Clock;
}

export class MarkDigestFailed {
  readonly #deps: MarkDigestFailedDeps;

  constructor(deps: MarkDigestFailedDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId, reason: string): Promise<void> {
    const digest = await this.#deps.digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    if (digest.status === 'failed' || digest.isFinished) return;
    digest.fail(reason, this.#deps.clock.now());
    await this.#deps.digests.save(digest);
  }
}
