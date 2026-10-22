import { type Kysely, sql } from 'kysely';

/** Page watch: the last seen version of each watched page, and 'change' items. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .createTable('page_snapshot')
    .addColumn('source_id', 'uuid', (c) => c.primaryKey().references('sources.source.id'))
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('content_hash', 'text', (c) => c.notNull())
    .addColumn('text', 'text', (c) => c.notNull())
    .addColumn('taken_at', 'timestamptz', (c) => c.notNull())
    .execute();

  await sql`alter table sources.item drop constraint item_kind_check`.execute(db);
  await sql`alter table sources.item add constraint item_kind_check check (kind in ('article', 'change'))`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sources.item drop constraint item_kind_check`.execute(db);
  await sql`alter table sources.item add constraint item_kind_check check (kind in ('article'))`.execute(
    db,
  );
  await db.schema.withSchema('sources').dropTable('page_snapshot').execute();
}
