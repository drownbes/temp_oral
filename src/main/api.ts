// Entrypoint for the HTTP API process. Telemetry starts before anything instrumented is imported.
import { startTelemetry } from '#shared/infrastructure/telemetry/telemetry.ts';

const telemetry = startTelemetry('temp-oral-api');
const { runApi } = await import('./api-server.ts');
await runApi(telemetry);
