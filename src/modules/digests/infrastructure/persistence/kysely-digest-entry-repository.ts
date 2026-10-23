import type { Kysely, Selectable } from 'kysely';
import type { DigestId } from '../../domain/digest.ts';
import type { DigestEntry } from '../../domain/digest-entry.ts';
import type { PublishedEntry } from '../../domain/earlier-coverage.ts';
import type { DigestEntryRepository } from '../../domain/repositories.ts';
import type { RunId } from '../../domain/run-id.ts';
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
          embedding: eb.ref('excluded.embedding'),
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

  async listPublished(ownerId: string, from: RunId, before: RunId): Promise<PublishedEntry[]> {
    const rows = await this.#db
      .selectFrom('digests.digest_entry as e')
      .innerJoin('digests.digest as d', 'd.id', 'e.digest_id')
      .select(['d.run_id', 'e.item_id', 'e.source_name', 'e.url', 'e.title', 'e.embedding'])
      .where('d.owner_id', '=', ownerId)
      .where('d.status', '=', 'published')
      .where('d.run_id', '>=', from)
      .where('d.run_id', '<', before)
      .where('e.embedding', 'is not', null)
      .orderBy('d.run_id')
      .orderBy('e.item_id')
      .execute();
    return rows.map((row) => ({
      runId: row.run_id as RunId,
      itemId: row.item_id,
      sourceName: row.source_name,
      url: row.url,
      title: row.title,
      embedding: row.embedding ?? [],
    }));
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
    embedding: row.embedding,
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
    embedding: entry.embedding ? [...entry.embedding] : null,
  };
}
