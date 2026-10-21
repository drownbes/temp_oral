import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .createTable('item')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('source_id', 'uuid', (c) => c.notNull().references('sources.source.id'))
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('article')`))
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('published_at', 'timestamptz')
    .addColumn('discovered_at', 'timestamptz', (c) => c.notNull())
    .addColumn('baseline', 'boolean', (c) => c.notNull())
    .addColumn('raw_key', 'text', (c) => c.notNull())
    .addColumn('text_key', 'text', (c) => c.notNull())
    .addColumn('exported_in_run', 'text')
    .addUniqueConstraint('item_source_url_key', ['source_id', 'url'])
    .execute();

  await db.schema
    .withSchema('sources')
    .createIndex('item_source_discovered_at_idx')
    .on('item')
    .columns(['source_id', 'discovered_at desc'])
    .execute();

  await db.schema
    .withSchema('sources')
    .createIndex('item_exported_in_run_idx')
    .on('item')
    .column('exported_in_run')
    .execute();

  // Small partial index for the claim: only items still waiting for a run
  await db.schema
    .withSchema('sources')
    .createIndex('item_unclaimed_idx')
    .on('item')
    .column('id')
    .where(sql.ref('exported_in_run'), 'is', null)
    .where(sql.ref('baseline'), '=', false)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('sources').dropTable('item').execute();
}
