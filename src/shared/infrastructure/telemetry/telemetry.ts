import { FastifyOtelInstrumentation } from '@fastify/otel';
import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { register as registerEsmHooks } from 'import-in-the-middle/register-hooks.mjs';

export interface Telemetry {
  readonly resource: Resource;
  /** Shared with the Temporal plugin so workflow spans use the same export pipeline. */
  readonly spanProcessor: SpanProcessor;
  shutdown(): Promise<void>;
}

const HEALTH_PATHS = /^\/health\//;

/**
 * Starts the OpenTelemetry SDK. Must run before the instrumented libraries are imported,
 * which is why the entrypoints in src/main import everything else dynamically afterwards.
 *
 * Exporter, sampler and resource attributes follow the standard OTEL_* environment
 * variables (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_TRACES_SAMPLER, OTEL_RESOURCE_ATTRIBUTES, ...).
 */
export function startTelemetry(defaultServiceName: string): Telemetry {
  // In-thread (module.registerHooks) ESM hook so instrumentations can patch modules loaded
  // via `import`. Unlike module.register() it is not inherited by Temporal's workflow threads.
  registerEsmHooks();

  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? defaultServiceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'unknown',
  });

  const enabled = process.env.OTEL_SDK_DISABLED !== 'true';
  const spanProcessor = enabled
    ? new BatchSpanProcessor(new OTLPTraceExporter())
    : new NoopSpanProcessor();

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => HEALTH_PATHS.test(req.url ?? ''),
      }),
      new UndiciInstrumentation(),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: ({ url }) => HEALTH_PATHS.test(url),
      }),
      new PgInstrumentation({ requireParentSpan: true }),
      new AwsInstrumentation({ suppressInternalInstrumentation: true }),
    ],
  });
  if (enabled) sdk.start();

  return {
    resource,
    spanProcessor,
    shutdown: () => (enabled ? sdk.shutdown() : Promise.resolve()),
  };
}
