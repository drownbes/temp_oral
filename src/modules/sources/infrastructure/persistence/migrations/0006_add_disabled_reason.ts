import type { Kysely } from 'kysely';

/** Why a source stopped being collected by itself (too many failures in a row). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .alterTable('source')
    .addColumn('disabled_reason', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('sources')
    .alterTable('source')
    .dropColumn('disabled_reason')
    .execute();
}
