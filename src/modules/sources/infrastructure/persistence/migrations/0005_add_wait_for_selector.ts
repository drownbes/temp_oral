import type { Kysely } from 'kysely';

/** Browser sources may name the element to wait for before the page is read. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .alterTable('source')
    .addColumn('wait_for_selector', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .alterTable('source')
    .dropColumn('wait_for_selector')
    .execute();
}
