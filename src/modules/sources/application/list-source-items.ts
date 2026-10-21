import { SourceNotFoundError } from '../domain/errors.ts';
import type { ItemSnapshot } from '../domain/item.ts';
import type { ItemRepository } from '../domain/item-repository.ts';
import type { SourceId } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';

export interface ListSourceItemsDeps {
  readonly sources: SourceRepository;
  readonly items: ItemRepository;
}

/** Most recently discovered first. */
export class ListSourceItems {
  readonly #deps: ListSourceItemsDeps;

  constructor(deps: ListSourceItemsDeps) {
    this.#deps = deps;
  }

  async execute(sourceId: SourceId, limit: number): Promise<ItemSnapshot[]> {
    const source = await this.#deps.sources.findById(sourceId);
    if (!source || source.isArchived) throw new SourceNotFoundError(sourceId);
    const items = await this.#deps.items.listBySource(sourceId, limit);
    return items.map((i) => i.toSnapshot());
  }
}
