import type { Kysely, Selectable } from 'kysely';
import { Item, type ItemId } from '../../domain/item.ts';
import type { ItemRepository } from '../../domain/item-repository.ts';
import type { RunId } from '../../domain/run-id.ts';
import type { SourceId } from '../../domain/source.ts';
import type { ItemTable, SourcesTables } from './tables.ts';

export class KyselyItemRepository implements ItemRepository {
  readonly #db: Kysely<SourcesTables>;

  constructor(db: Kysely<SourcesTables>) {
    this.#db = db;
  }

  async knownUrls(sourceId: SourceId, urls: readonly string[]): Promise<Set<string>> {
    if (urls.length === 0) return new Set();
    const rows = await this.#db
      .selectFrom('sources.item')
      .select('url')
      .where('source_id', '=', sourceId)
      .where('url', 'in', urls)
      .execute();
    return new Set(rows.map((r) => r.url));
  }

  async addNew(items: readonly Item[]): Promise<void> {
    if (items.length === 0) return;
    await this.#db
      .insertInto('sources.item')
      .values(items.map(toRow))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async listBySource(sourceId: SourceId, limit: number): Promise<Item[]> {
    const rows = await this.#db
      .selectFrom('sources.item')
      .selectAll()
      .where('source_id', '=', sourceId)
      .orderBy('discovered_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toDomain);
  }

  async claimForRun(runId: RunId): Promise<Item[]> {
    // A single UPDATE: under concurrent runs Postgres re-checks the WHERE after locking each
    // row, so an item is claimed by whichever run gets there first and never by both.
    await this.#db
      .updateTable('sources.item')
      .set({ exported_in_run: runId })
      .where('exported_in_run', 'is', null)
      .where('baseline', '=', false)
      .execute();
    const rows = await this.#db
      .selectFrom('sources.item')
      .selectAll()
      .where('exported_in_run', '=', runId)
      .orderBy('discovered_at')
      .orderBy('id')
      .execute();
    return rows.map(toDomain);
  }
}

function toDomain(row: Selectable<ItemTable>): Item {
  return Item.restore({
    id: row.id as ItemId,
    sourceId: row.source_id as SourceId,
    kind: row.kind,
    url: row.url,
    title: row.title,
    publishedAt: row.published_at,
    discoveredAt: row.discovered_at,
    baseline: row.baseline,
    content: { rawKey: row.raw_key, textKey: row.text_key },
    exportedInRun: row.exported_in_run as RunId | null,
  });
}

function toRow(item: Item): ItemTable {
  const s = item.toSnapshot();
  return {
    id: s.id,
    source_id: s.sourceId,
    kind: s.kind,
    url: s.url,
    title: s.title,
    published_at: s.publishedAt,
    discovered_at: s.discoveredAt,
    baseline: s.baseline,
    raw_key: s.content.rawKey,
    text_key: s.content.textKey,
    exported_in_run: s.exportedInRun,
  };
}
