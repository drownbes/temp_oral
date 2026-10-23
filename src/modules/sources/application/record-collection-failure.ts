import type { Clock } from '#shared/kernel/clock.ts';
import { SourceNotFoundError } from '../domain/errors.ts';
import type { SourceId } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';

export interface RecordCollectionFailureDeps {
  readonly repository: SourceRepository;
  readonly clock: Clock;
  /** Failed collections in a row after which a source stops being collected. */
  readonly maxConsecutiveFailures: number;
}

export interface RecordedFailure {
  readonly sourceName: string;
  /** This failure stopped the source. */
  readonly disabled: boolean;
}

/**
 * Called once per run after collecting a source finally failed. A failure that is not the
 * source's fault (no browser worker to collect it) is reported but not held against it.
 */
export class RecordCollectionFailure {
  readonly #deps: RecordCollectionFailureDeps;

  constructor(deps: RecordCollectionFailureDeps) {
    this.#deps = deps;
  }

  async execute(
    sourceId: SourceId,
    reason: string,
    countsAgainstSource = true,
  ): Promise<RecordedFailure> {
    const { repository, clock, maxConsecutiveFailures } = this.#deps;
    const source = await repository.findById(sourceId);
    if (!source) throw new SourceNotFoundError(sourceId);
    if (!countsAgainstSource) return { sourceName: source.name, disabled: false };

    const wasCollectable = source.isCollectable;
    source.recordFailure(reason, clock.now(), maxConsecutiveFailures);
    await repository.save(source);
    return { sourceName: source.name, disabled: wasCollectable && !source.isCollectable };
  }
}
