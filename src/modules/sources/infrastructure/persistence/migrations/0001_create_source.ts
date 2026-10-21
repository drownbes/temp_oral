import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .createTable('source')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('owner_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('feed', 'listing', 'page')`))
    .addColumn('fetch_mode', 'text', (c) =>
      c.notNull().check(sql`fetch_mode in ('http', 'browser')`),
    )
    .addColumn('link_selector', 'text')
    .addColumn('url_pattern', 'text')
    .addColumn('content_selector', 'text')
    .addColumn('enabled', 'boolean', (c) => c.notNull())
    .addColumn('etag', 'text')
    .addColumn('last_modified', 'text')
    .addColumn('last_collected_at', 'timestamptz')
    .addColumn('consecutive_failures', 'integer', (c) => c.notNull())
    .addColumn('last_error', 'text')
    .addColumn('baselined_at', 'timestamptz')
    .addColumn('archived_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute();

  // Archived sources keep their row, so the URL may be added again
  await db.schema
    .withSchema('sources')
    .createIndex('source_owner_url_active_key')
    .on('source')
    .columns(['owner_id', 'url'])
    .unique()
    .where(sql.ref('archived_at'), 'is', null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('sources').dropTable('source').execute();
}
