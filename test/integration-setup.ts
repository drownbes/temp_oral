import { sql } from 'kysely';
import { createDatabase } from '#shared/infrastructure/db/database.ts';
import { migrateToLatest } from '#shared/infrastructure/db/migrations.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { modules } from '../src/main/modules.ts';
import { integrationConfig } from './integration-env.ts';

/** Creates the test database if needed and migrates every module's schema. */
export default async function setup(): Promise<void> {
  const config = integrationConfig();
  const logger = createLogger(config, 'test');
  const testDb = new URL(config.database.url);
  const dbName = testDb.pathname.slice(1);

  const adminUrl = new URL(testDb);
  adminUrl.pathname = '/postgres';
  const admin = createDatabase(
    { ...config, database: { ...config.database, url: adminUrl.href } },
    logger,
  );
  try {
    const exists = await sql`select 1 from pg_database where datname = ${dbName}`.execute(admin);
    if (exists.rows.length === 0) await sql`create database ${sql.id(dbName)}`.execute(admin);
  } catch (err) {
    throw new Error('Postgres is not reachable. Start the local stack with `pnpm dev` first.', {
      cause: err,
    });
  } finally {
    await admin.destroy();
  }

  const db = createDatabase(config, logger);
  try {
    await migrateToLatest(
      db,
      modules.map((m) => m.migrations),
      logger,
    );
  } finally {
    await db.destroy();
  }
}
