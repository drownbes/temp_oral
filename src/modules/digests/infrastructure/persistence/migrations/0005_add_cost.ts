import type { Kysely } from 'kysely';

/** What a digest's LLM calls cost in USD; null when a model's price was unknown. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('digests')
    .alterTable('digest')
    .addColumn('cost_usd', 'double precision')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('digests').alterTable('digest').dropColumn('cost_usd').execute();
}
