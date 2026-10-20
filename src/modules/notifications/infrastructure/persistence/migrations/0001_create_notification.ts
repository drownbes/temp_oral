import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('notifications')
    .createTable('notification')
    .addColumn('id', 'uuid', (c) => c.primaryKey())
    .addColumn('idempotency_key', 'text', (c) => c.notNull().unique())
    .addColumn('recipient', 'text', (c) => c.notNull())
    .addColumn('subject', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().check(sql`status in ('pending', 'sent')`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('sent_at', 'timestamptz')
    .execute();

  await db.schema
    .withSchema('notifications')
    .createIndex('notification_recipient_created_at_idx')
    .on('notification')
    .columns(['recipient', 'created_at desc'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('notifications').dropTable('notification').execute();
}
