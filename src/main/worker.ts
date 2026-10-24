// Entrypoint for the Temporal worker process. Telemetry starts before anything instrumented is imported.
import { startTelemetry } from '#shared/infrastructure/telemetry/telemetry.ts';

const telemetry = startTelemetry('worker');
const { runWorker } = await import('./worker-runtime.ts');
await runWorker(telemetry);
