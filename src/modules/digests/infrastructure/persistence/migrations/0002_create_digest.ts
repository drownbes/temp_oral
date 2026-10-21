import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('digests')
    .createTable('digest')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('owner_id', 'text', (c) => c.notNull())
    .addColumn('run_id', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .check(
          sql`status in ('collecting', 'enriching', 'rendering', 'published', 'superseded', 'failed')`,
        ),
    )
    .addColumn('export_key', 'text')
    .addColumn('item_count', 'integer', (c) => c.notNull())
    .addColumn('failed_sources', 'jsonb', (c) => c.notNull())
    .addColumn('batch_ref', 'text')
    .addColumn('analyzed_count', 'integer', (c) => c.notNull())
    .addColumn('failed_item_count', 'integer', (c) => c.notNull())
    .addColumn('input_tokens', 'integer', (c) => c.notNull())
    .addColumn('output_tokens', 'integer', (c) => c.notNull())
    .addColumn('failure_reason', 'text')
    .addColumn('published_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('digest_owner_run_key', ['owner_id', 'run_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('digests').dropTable('digest').execute();
}
