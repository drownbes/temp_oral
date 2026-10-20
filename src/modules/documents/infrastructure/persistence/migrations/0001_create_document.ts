import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('documents')
    .createTable('document')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('filename', 'text', (c) => c.notNull())
    .addColumn('content_type', 'text', (c) => c.notNull())
    .addColumn('size_bytes', 'integer', (c) => c.notNull())
    .addColumn('uploaded_by', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) =>
      c.notNull().check(sql`status in ('uploaded', 'processing', 'processed', 'failed')`),
    )
    .addColumn('checksum', 'text')
    .addColumn('failure_reason', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('documents').dropTable('document').execute();
}
