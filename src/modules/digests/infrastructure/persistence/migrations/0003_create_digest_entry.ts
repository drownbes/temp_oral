import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // item_id / source_id come from the sources context: plain values, no foreign keys across schemas
  await db.schema
    .withSchema('digests')
    .createTable('digest_entry')
    .addColumn('digest_id', 'uuid', (c) => c.notNull().references('digests.digest.id'))
    .addColumn('item_id', 'text', (c) => c.notNull())
    .addColumn('source_id', 'text', (c) => c.notNull())
    .addColumn('source_name', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('published_at', 'timestamptz')
    .addColumn('summary', 'text')
    .addColumn('relevance', 'real')
    .addColumn('reason', 'text')
    .addColumn('tags', sql`text[]`)
    .addColumn('failure', 'text')
    .addPrimaryKeyConstraint('digest_entry_pkey', ['digest_id', 'item_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('digests').dropTable('digest_entry').execute();
}
