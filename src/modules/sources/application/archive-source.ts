import type { Clock } from '#shared/kernel/clock.ts';
import { SourceNotFoundError } from '../domain/errors.ts';
import type { SourceId } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';

export interface ArchiveSourceDeps {
  readonly repository: SourceRepository;
  readonly clock: Clock;
}

/** "Deleting" a source archives it: collection stops, already collected items stay. */
export class ArchiveSource {
  readonly #deps: ArchiveSourceDeps;

  constructor(deps: ArchiveSourceDeps) {
    this.#deps = deps;
  }

  async execute(id: SourceId): Promise<void> {
    const source = await this.#deps.repository.findById(id);
    if (!source || source.isArchived) throw new SourceNotFoundError(id);
    source.archive(this.#deps.clock.now());
    await this.#deps.repository.save(source);
  }
}
