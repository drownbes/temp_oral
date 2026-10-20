import type { AppConfig } from '#shared/infrastructure/config.ts';
import { createDatabase } from '#shared/infrastructure/db/database.ts';
import type { Lifecycle } from '#shared/infrastructure/lifecycle.ts';
import type { Logger } from '#shared/infrastructure/logger.ts';
import type { ModuleDeps } from '#shared/infrastructure/module.ts';
import { createS3Client } from '#shared/infrastructure/s3/s3.ts';
import type { Telemetry } from '#shared/infrastructure/telemetry/telemetry.ts';
import { createTemporalClient } from '#shared/infrastructure/temporal/client.ts';

/** Creates the process-wide shared infrastructure and registers it for shutdown. */
export async function createModuleDeps(
  config: AppConfig,
  logger: Logger,
  telemetry: Telemetry,
  lifecycle: Lifecycle,
): Promise<ModuleDeps> {
  const db = createDatabase(config, logger);
  lifecycle.onShutdown('postgres', () => db.destroy());

  const s3 = createS3Client(config);
  lifecycle.onShutdown('s3', async () => s3.destroy());

  const temporal = await createTemporalClient(config, telemetry);
  lifecycle.onShutdown('temporal-client', () => temporal.connection.close());

  return { config, logger, db, s3, temporal };
}
