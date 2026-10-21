import { SourceNotFoundError } from '../domain/errors.ts';
import type { SourceId, SourceSnapshot } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';

export class GetSource {
  readonly #repository: SourceRepository;

  constructor(repository: SourceRepository) {
    this.#repository = repository;
  }

  async execute(id: SourceId): Promise<SourceSnapshot> {
    const source = await this.#repository.findById(id);
    if (!source || source.isArchived) throw new SourceNotFoundError(id);
    return source.toSnapshot();
  }
}
