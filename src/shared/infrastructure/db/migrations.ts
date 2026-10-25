import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import type { Logger } from '../logger.ts';
import type { Database } from './database.ts';

/** A bounded context's migrations. History is tracked per schema, so contexts never share it. */
export interface ModuleMigrations {
  readonly schema: string;
  readonly folder: string;
}

/**
 * Safe to run from several processes at once (each deployment migrates before it starts): a
 * session advisory lock serialises whole runs, including the `create schema` that Kysely's own
 * per-schema lock doesn't cover.
 */
export async function migrateToLatest(
  db: Database,
  modules: readonly ModuleMigrations[],
  logger: Logger,
): Promise<void> {
  await db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(hashtext('temp-oral:migrations'))`.execute(conn);
    try {
      await migrateModules(conn, modules, logger);
    } finally {
      await sql`select pg_advisory_unlock(hashtext('temp-oral:migrations'))`.execute(conn);
    }
  });
}

async function migrateModules(
  db: Database,
  modules: readonly ModuleMigrations[],
  logger: Logger,
): Promise<void> {
  for (const { schema, folder } of modules) {
    await sql`create schema if not exists ${sql.id(schema)}`.execute(db);

    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({ fs, path, migrationFolder: folder }),
      migrationTableSchema: schema,
    });
    const { error, results = [] } = await migrator.migrateToLatest();

    for (const result of results) {
      const log = { schema, migration: result.migrationName, status: result.status };
      if (result.status === 'Error') logger.error(log, 'migration failed');
      else logger.info(log, 'migration applied');
    }
    if (error) throw new Error(`migrations for schema "${schema}" failed`, { cause: error });
    if (results.length === 0) logger.info({ schema }, 'schema up to date');
  }
}
