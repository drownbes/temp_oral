// Applies every module's migrations, each in its own Postgres schema.
import { loadConfig } from '#shared/infrastructure/config.ts';
import { createDatabase } from '#shared/infrastructure/db/database.ts';
import { migrateToLatest } from '#shared/infrastructure/db/migrations.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { modules } from './modules.ts';

const config = loadConfig();
const logger = createLogger(config, 'migrate');
const db = createDatabase(config, logger);

try {
  await migrateToLatest(
    db,
    modules.map((m) => m.migrations),
    logger,
  );
} catch (err) {
  logger.error({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
