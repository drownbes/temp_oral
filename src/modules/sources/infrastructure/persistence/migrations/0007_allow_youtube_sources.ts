import { type Kysely, sql } from 'kysely';

/** YouTube channels as sources; they keep no options of their own. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sources.source drop constraint source_kind_check`.execute(db);
  await sql`alter table sources.source add constraint source_kind_check check (kind in ('feed', 'listing', 'page', 'youtube'))`.execute(
    db,
  );
}

/** Fails while YouTube sources exist; archive and delete them first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sources.source drop constraint source_kind_check`.execute(db);
  await sql`alter table sources.source add constraint source_kind_check check (kind in ('feed', 'listing', 'page'))`.execute(
    db,
  );
}
