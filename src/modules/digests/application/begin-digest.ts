import type { Clock } from '#shared/kernel/clock.ts';
import { Digest, newDigestId } from '../domain/digest.ts';
import type { DigestRepository } from '../domain/repositories.ts';
import { parseRunId, runIdAt } from '../domain/run-id.ts';
import { type DigestState, toState } from './digest-state.ts';

export interface BeginDigestCommand {
  readonly ownerId: string;
  /** Explicit day, or derived from `startedAt` in the digest time zone (scheduled runs). */
  readonly runId?: string;
  /** ISO timestamp the run was started at. */
  readonly startedAt: string;
}

export interface BeginDigestDeps {
  readonly digests: DigestRepository;
  readonly clock: Clock;
  readonly timezone: string;
}

/**
 * First step of a digest run. Idempotent: returns the existing digest of that day as it is,
 * so a re-run resumes where the last one stopped; a failed one starts over.
 */
export class BeginDigest {
  readonly #deps: BeginDigestDeps;

  constructor(deps: BeginDigestDeps) {
    this.#deps = deps;
  }

  async execute(command: BeginDigestCommand): Promise<DigestState> {
    const { digests, clock, timezone } = this.#deps;
    const runId = command.runId
      ? parseRunId(command.runId)
      : runIdAt(new Date(command.startedAt), timezone);

    let digest = await digests.findByRun(command.ownerId, runId);
    if (!digest) {
      digest = Digest.begin({
        id: newDigestId(),
        ownerId: command.ownerId,
        runId,
        now: clock.now(),
      });
      await digests.save(digest);
    } else if (digest.status === 'failed') {
      digest.restart(clock.now());
      await digests.save(digest);
    }
    return toState(digest);
  }
}
