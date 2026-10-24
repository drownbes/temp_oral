import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { loadConfig } from '#shared/infrastructure/config.ts';
import { Lifecycle } from '#shared/infrastructure/lifecycle.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import type { Telemetry } from '#shared/infrastructure/telemetry/telemetry.ts';
import { logTraceInterceptors } from '#shared/infrastructure/temporal/log-trace-interceptors.ts';
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
  // Temporal's metrics (task slots, schedule-to-start latency, failures) come from its Rust
  // core, which exports them itself, to the same OTLP endpoint as the Node SDK's metrics.
  // Its resource is `temporal-core-sdk` unless OTEL_SERVICE_NAME is set, and attachServiceName
  // would label every metric with that too; report as this process's service instead.
  process.env.OTEL_SERVICE_NAME ??= String(telemetry.resource.attributes[ATTR_SERVICE_NAME]);
  Runtime.install({
    logger: new PinoTemporalLogger(logger),
    telemetryOptions: telemetry.metricsUrl
      ? {
          metrics: {
            otel: { url: telemetry.metricsUrl, http: true, useSecondsForDurations: true },
            attachServiceName: false,
          },
        }
      : undefined,
  });

  const deps = await createModuleDeps(config, logger, telemetry, lifecycle);
  const connection = await NativeConnection.connect(connectionOptions(config.temporal));
  lifecycle.onShutdown('temporal-worker-connection', () => connection.close());

  const plugin = temporalTracingPlugin(telemetry);
  // WORKER_TASK_QUEUES lets one deployment serve only some queues (e.g. a browser-only worker)
  const definitions = modules
    .flatMap((module) => module.worker?.(deps) ?? [])
    .filter(
      ({ taskQueue }) => !config.worker.taskQueues || config.worker.taskQueues.has(taskQueue),
    );
  if (definitions.length === 0) {
    logger.error({ taskQueues: [...(config.worker.taskQueues ?? [])] }, 'no task queues to serve');
    process.exitCode = 1;
    await lifecycle.shutdown();
    return;
  }
  const workers = await Promise.all(
    definitions.map(({ taskQueue, workflowsPath, activities, maxConcurrentActivities }) =>
      Worker.create({
        connection,
        namespace: config.temporal.namespace,
        taskQueue,
        workflowsPath,
        activities,
        maxConcurrentActivityTaskExecutions: maxConcurrentActivities,
        plugins: [plugin],
        interceptors: logTraceInterceptors(),
      }),
    ),
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
