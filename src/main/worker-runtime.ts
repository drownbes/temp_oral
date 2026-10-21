import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { loadConfig } from '#shared/infrastructure/config.ts';
import { Lifecycle } from '#shared/infrastructure/lifecycle.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import type { Telemetry } from '#shared/infrastructure/telemetry/telemetry.ts';
import { PinoTemporalLogger } from '#shared/infrastructure/temporal/logger.ts';
import { upsertSchedules } from '#shared/infrastructure/temporal/schedules.ts';
import {
  connectionOptions,
  temporalTracingPlugin,
} from '#shared/infrastructure/temporal/temporal.ts';
import { createModuleDeps } from './deps.ts';
import { modules } from './modules.ts';

/**
 * Runs one Temporal worker per module task queue in this process. Since each module has its
 * own queue, a module can later get a dedicated worker deployment without code changes.
 */
export async function runWorker(telemetry: Telemetry): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, 'worker');
  const lifecycle = new Lifecycle(logger);
  lifecycle.onShutdown('telemetry', () => telemetry.shutdown());

  // The Runtime handles SIGINT/SIGTERM by draining all workers; run() then resolves below.
  Runtime.install({ logger: new PinoTemporalLogger(logger) });

  const deps = await createModuleDeps(config, logger, telemetry, lifecycle);
  const connection = await NativeConnection.connect(connectionOptions(config.temporal));
  lifecycle.onShutdown('temporal-worker-connection', () => connection.close());

  const plugin = temporalTracingPlugin(telemetry);
  const workers = await Promise.all(
    modules.flatMap((module) => {
      if (!module.worker) return [];
      const { taskQueue, workflowsPath, activities } = module.worker(deps);
      return Worker.create({
        connection,
        namespace: config.temporal.namespace,
        taskQueue,
        workflowsPath,
        activities,
        plugins: [plugin],
      });
    }),
  );
  logger.info({ taskQueues: workers.map((w) => w.options.taskQueue) }, 'workers started');

  // After the workers exist, so a schedule firing right away finds someone to run it. A bad
  // schedule (e.g. invalid cron) fails startup rather than silently never running.
  try {
    await upsertSchedules(
      deps.temporal,
      modules.flatMap((module) => module.schedules?.(deps) ?? []),
      logger,
    );
  } catch (err) {
    logger.error({ err }, 'schedule setup failed');
    process.exitCode = 1;
    await lifecycle.shutdown();
    return;
  }

  try {
    await Promise.all(
      workers.map((worker) =>
        worker.run().catch((err: unknown) => {
          // One failed worker takes the process down so the orchestrator restarts it
          for (const other of workers) if (other.getState() === 'RUNNING') other.shutdown();
          throw err;
        }),
      ),
    );
  } catch (err) {
    logger.error({ err }, 'worker failed');
    process.exitCode = 1;
  } finally {
    await lifecycle.shutdown();
  }
}
