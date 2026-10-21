import type { Kysely, Selectable } from 'kysely';
import type { DigestId } from '../../domain/digest.ts';
import type { DigestEntry } from '../../domain/digest-entry.ts';
import type { DigestEntryRepository } from '../../domain/repositories.ts';
import type { DigestEntryTable, DigestsTables } from './tables.ts';

export class KyselyDigestEntryRepository implements DigestEntryRepository {
  readonly #db: Kysely<DigestsTables>;

  constructor(db: Kysely<DigestsTables>) {
    this.#db = db;
  }

  async saveAll(entries: readonly DigestEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.#db
      .insertInto('digests.digest_entry')
      .values(entries.map(toRow))
      .onConflict((oc) =>
        oc.columns(['digest_id', 'item_id']).doUpdateSet((eb) => ({
          source_name: eb.ref('excluded.source_name'),
          url: eb.ref('excluded.url'),
          title: eb.ref('excluded.title'),
          published_at: eb.ref('excluded.published_at'),
          summary: eb.ref('excluded.summary'),
          relevance: eb.ref('excluded.relevance'),
          reason: eb.ref('excluded.reason'),
          tags: eb.ref('excluded.tags'),
          failure: eb.ref('excluded.failure'),
        })),
      )
      .execute();
  }

  async listByDigest(digestId: DigestId): Promise<DigestEntry[]> {
    const rows = await this.#db
      .selectFrom('digests.digest_entry')
      .selectAll()
      .where('digest_id', '=', digestId)
      .orderBy('item_id')
      .execute();
    return rows.map(toDomain);
  }
}

function toDomain(row: Selectable<DigestEntryTable>): DigestEntry {
  return {
    digestId: row.digest_id as DigestId,
    itemId: row.item_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    url: row.url,
    title: row.title,
    publishedAt: row.published_at,
    analysis:
      row.summary !== null && row.relevance !== null
        ? {
            summary: row.summary,
            relevance: row.relevance,
            reason: row.reason ?? '',
            tags: row.tags ?? [],
          }
        : null,
    failure: row.failure,
  };
}

function toRow(entry: DigestEntry): DigestEntryTable {
  return {
    digest_id: entry.digestId,
    item_id: entry.itemId,
    source_id: entry.sourceId,
    source_name: entry.sourceName,
    url: entry.url,
    title: entry.title,
    published_at: entry.publishedAt,
    summary: entry.analysis?.summary ?? null,
    relevance: entry.analysis?.relevance ?? null,
    reason: entry.analysis?.reason ?? null,
    tags: entry.analysis ? [...entry.analysis.tags] : null,
    failure: entry.failure,
  };
}
