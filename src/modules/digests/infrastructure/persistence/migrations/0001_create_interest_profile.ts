import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('digests')
    .createTable('interest_profile')
    .addColumn('owner_id', 'text', (c) => c.primaryKey())
    .addColumn('interests', 'text', (c) => c.notNull())
    .addColumn('relevance_threshold', 'real', (c) =>
      c.notNull().check(sql`relevance_threshold between 0 and 1`),
    )
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('digests').dropTable('interest_profile').execute();
}
