import type { SourceSnapshot } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';

export class ListSources {
  readonly #repository: SourceRepository;

  constructor(repository: SourceRepository) {
    this.#repository = repository;
  }

  async execute(ownerId: string): Promise<SourceSnapshot[]> {
    const sources = await this.#repository.listActive(ownerId);
    return sources.map((s) => s.toSnapshot());
  }
}
