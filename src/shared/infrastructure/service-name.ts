/** Name of the whole system, e.g. Postgres `application_name`. */
export const SYSTEM_NAME = 'temp-oral';

/**
 * `service.name` of this process, shared by its traces, metrics and logs so they line up:
 * OTEL_SERVICE_NAME when set, otherwise `temp-oral-<component>` (temp-oral-api, temp-oral-worker).
 * Read from the environment because telemetry starts before the config is loaded.
 */
export function serviceName(component: string): string {
  return process.env.OTEL_SERVICE_NAME ?? `${SYSTEM_NAME}-${component}`;
}
