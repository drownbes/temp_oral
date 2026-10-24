import { sql } from 'kysely';
import { loadConfig } from '#shared/infrastructure/config.ts';
import { createHttpServer } from '#shared/infrastructure/http/server.ts';
import { Lifecycle } from '#shared/infrastructure/lifecycle.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import type { Telemetry } from '#shared/infrastructure/telemetry/telemetry.ts';
import { createModuleDeps } from './deps.ts';
import { modules } from './modules.ts';

export async function runApi(telemetry: Telemetry): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, 'api');
  const lifecycle = new Lifecycle(logger);
  lifecycle.onShutdown('telemetry', () => telemetry.shutdown());
  lifecycle.handleSignals();

  const deps = await createModuleDeps(config, logger, telemetry, lifecycle);

  const app = await createHttpServer({
    logger,
    readinessChecks: {
      postgres: () => sql`select 1`.execute(deps.db),
      temporal: () => deps.temporal.workflowService.getSystemInfo({}),
    },
  });
  for (const module of modules) {
    if (module.http) await app.register(module.http(deps));
  }
  lifecycle.onShutdown('http', () => app.close());

  await app.listen({ host: config.http.host, port: config.http.port });
}
