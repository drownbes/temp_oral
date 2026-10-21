import type { Clock } from '#shared/kernel/clock.ts';
import { SourceNotFoundError } from '../domain/errors.ts';
import type { SourceId } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';

export interface RecordCollectionFailureDeps {
  readonly repository: SourceRepository;
  readonly clock: Clock;
}

/** Called once per run after collecting a source finally failed. */
export class RecordCollectionFailure {
  readonly #deps: RecordCollectionFailureDeps;

  constructor(deps: RecordCollectionFailureDeps) {
    this.#deps = deps;
  }

  async execute(sourceId: SourceId, reason: string): Promise<void> {
    const source = await this.#deps.repository.findById(sourceId);
    if (!source) throw new SourceNotFoundError(sourceId);
    source.recordFailure(reason, this.#deps.clock.now());
    await this.#deps.repository.save(source);
  }
}
