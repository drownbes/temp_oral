import type { Kysely } from 'kysely';

/** The one retry batch for items the first analysis batch could not analyse. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('digests')
    .alterTable('digest')
    .addColumn('reanalysis_batch_ref', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('digests')
    .alterTable('digest')
    .dropColumn('reanalysis_batch_ref')
    .execute();
}
