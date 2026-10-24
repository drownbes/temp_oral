import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { AppConfig } from '../config.ts';
import type { Logger } from '../logger.ts';
import { SYSTEM_NAME } from '../service-name.ts';

/**
 * One pool per process, shared by all modules. Each bounded context narrows it to its
 * own tables with `db.withTables<ContextTables>()` and keeps them in its own schema.
 */
// biome-ignore lint/complexity/noBannedTypes: the shared handle intentionally knows no tables
export type Database = Kysely<{}>;

export function createDatabase(config: AppConfig, logger: Logger): Database {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    application_name: SYSTEM_NAME,
  });
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

  return new Kysely({
    dialect: new PostgresDialect({ pool }),
    log(event) {
      if (event.level === 'error') {
        logger.error(
          { err: event.error, sql: event.query.sql, durationMs: event.queryDurationMillis },
          'query failed',
        );
      }
    },
  });
}
