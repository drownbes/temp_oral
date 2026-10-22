import type { Kysely } from 'kysely';

/** Feeds may fetch each new article's page when they only carry teasers (on by default). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .alterTable('source')
    .addColumn('fetch_articles', 'boolean', (c) => c.notNull().defaultTo(true))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('sources').alterTable('source').dropColumn('fetch_articles').execute();
}
