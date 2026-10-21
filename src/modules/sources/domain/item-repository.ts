import type { Item } from './item.ts';
import type { RunId } from './run-id.ts';
import type { SourceId } from './source.ts';

/** Port: persistence of items. Items are immutable once discovered, except for the run claim. */
export interface ItemRepository {
  /** Which of `urls` (canonical) are already stored for the source. */
  knownUrls(sourceId: SourceId, urls: readonly string[]): Promise<Set<string>>;
  /** Inserts new items; items whose id already exists are left as they are. */
  addNew(items: readonly Item[]): Promise<void>;
  listBySource(sourceId: SourceId, limit: number): Promise<Item[]>;
  /**
   * Atomically assigns every unclaimed, non-baseline item to `runId` and returns all items
   * of that run (including ones claimed by an earlier attempt of the same run).
   */
  claimForRun(runId: RunId): Promise<Item[]>;
}
