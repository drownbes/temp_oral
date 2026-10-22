import type { Kysely } from 'kysely';
import { PageSnapshot } from '../../domain/page-watch.ts';
import type { SourceId } from '../../domain/source.ts';
import type { PageSnapshotRepository } from '../../domain/source-repository.ts';
import type { SourcesTables } from './tables.ts';

export class KyselyPageSnapshotRepository implements PageSnapshotRepository {
  readonly #db: Kysely<SourcesTables>;

  constructor(db: Kysely<SourcesTables>) {
    this.#db = db;
  }

  async find(sourceId: SourceId): Promise<PageSnapshot | undefined> {
    const row = await this.#db
      .selectFrom('sources.page_snapshot')
      .selectAll()
      .where('source_id', '=', sourceId)
      .executeTakeFirst();
    return (
      row &&
      PageSnapshot.restore({
        sourceId: row.source_id as SourceId,
        url: row.url,
        contentHash: row.content_hash,
        text: row.text,
        takenAt: row.taken_at,
      })
    );
  }

  async save(snapshot: PageSnapshot): Promise<void> {
    const s = snapshot.toSnapshot();
    const changes = { url: s.url, content_hash: s.contentHash, text: s.text, taken_at: s.takenAt };
    await this.#db
      .insertInto('sources.page_snapshot')
      .values({ source_id: s.sourceId, ...changes })
      .onConflict((oc) => oc.column('source_id').doUpdateSet(changes))
      .execute();
  }
}
