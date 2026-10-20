import { Client, Connection } from '@temporalio/client';
import type { AppConfig } from '../config.ts';
import type { Telemetry } from '../telemetry/telemetry.ts';
import { connectionOptions, temporalTracingPlugin } from './temporal.ts';

export async function createTemporalClient(
  config: AppConfig,
  telemetry: Telemetry,
): Promise<Client> {
  const connection = await Connection.connect(connectionOptions(config.temporal));
  return new Client({
    connection,
    namespace: config.temporal.namespace,
    plugins: [temporalTracingPlugin(telemetry)],
  });
}
