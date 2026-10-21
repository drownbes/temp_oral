import { type Kysely, sql } from 'kysely';

/** Phase 3: embeddings per entry, story clusters, synthesis batch and overview per digest. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('digests')
    .alterTable('digest')
    .renameColumn('batch_ref', 'analysis_batch_ref')
    .execute();
  await db.schema
    .withSchema('digests')
    .alterTable('digest')
    .addColumn('embedding_batch_ref', 'text')
    .addColumn('synthesis_batch_ref', 'text')
    .addColumn('clusters', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('overview', 'text')
    .execute();
  await sql`alter table digests.digest drop constraint digest_status_check`.execute(db);
  await sql`
    alter table digests.digest add constraint digest_status_check check (status in
      ('collecting', 'enriching', 'synthesizing', 'rendering', 'published', 'superseded', 'failed'))
  `.execute(db);

  await db.schema
    .withSchema('digests')
    .alterTable('digest_entry')
    .addColumn('embedding', sql`real[]`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('digests')
    .alterTable('digest_entry')
    .dropColumn('embedding')
    .execute();
  await sql`alter table digests.digest drop constraint digest_status_check`.execute(db);
  await sql`
    alter table digests.digest add constraint digest_status_check check (status in
      ('collecting', 'enriching', 'rendering', 'published', 'superseded', 'failed'))
  `.execute(db);
  await db.schema
    .withSchema('digests')
    .alterTable('digest')
    .dropColumn('embedding_batch_ref')
    .dropColumn('synthesis_batch_ref')
    .dropColumn('clusters')
    .dropColumn('overview')
    .execute();
  await db.schema
    .withSchema('digests')
    .alterTable('digest')
    .renameColumn('analysis_batch_ref', 'batch_ref')
    .execute();
}
