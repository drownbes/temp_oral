import { FastifyOtelInstrumentation } from '@fastify/otel';
import { DiagConsoleLogger, DiagLogLevel, diag, SpanStatusCode } from '@opentelemetry/api';
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
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { register as registerEsmHooks } from 'import-in-the-middle/register-hooks.mjs';
import { serviceName } from '../service-name.ts';

export interface Telemetry {
  readonly resource: Resource;
  /** Shared with the Temporal plugin so workflow spans use the same export pipeline. */
  readonly spanProcessor: SpanProcessor;
  /** OTLP/HTTP metrics URL the SDK exports to, for Temporal's own metrics; unset when off. */
  readonly metricsUrl: string | undefined;
  shutdown(): Promise<void>;
}

const HEALTH_PATHS = /^\/health\//;

/**
 * Starts the OpenTelemetry SDK. Must run before the instrumented libraries are imported,
 * which is why the entrypoints in src/main import everything else dynamically afterwards.
 *
 * Exporters, sampler and resource attributes follow the standard OTEL_* environment
 * variables (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
 * OTEL_METRICS_EXPORTER, OTEL_TRACES_SAMPLER, OTEL_RESOURCE_ATTRIBUTES, ...).
 */
export function startTelemetry(component: string): Telemetry {
  // In-thread (module.registerHooks) ESM hook so instrumentations can patch modules loaded
  // via `import`. Unlike module.register() it is not inherited by Temporal's workflow threads.
  registerEsmHooks();

  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName(component),
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'unknown',
  });

  const enabled = process.env.OTEL_SDK_DISABLED !== 'true';
  const spanProcessor = enabled
    ? new BatchSpanProcessor(new OTLPTraceExporter())
    : new NoopSpanProcessor();

  // Metric readers come from the environment (OTEL_METRICS_EXPORTER, otlp by default)
  const sdk = new NodeSDK({
    resource,
    spanProcessors: [new ClientErrorStatusProcessor(), spanProcessor],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => HEALTH_PATHS.test(req.url ?? ''),
      }),
      new UndiciInstrumentation(),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        // The request span covers the handler; a handler span would also be marked failed on
        // every 4xx, and it ends before the response status is known.
        instrumentHandler: false,
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
    metricsUrl: enabled ? otlpMetricsUrl() : undefined,
    shutdown: () => (enabled ? sdk.shutdown() : Promise.resolve()),
  };
}

/** Where the SDK sends metrics, resolved like its OTLP/HTTP exporter does. */
function otlpMetricsUrl(): string | undefined {
  const exporters = (process.env.OTEL_METRICS_EXPORTER ?? 'otlp').split(',').map((e) => e.trim());
  if (!exporters.includes('otlp') || exporters.includes('none')) return undefined;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  return process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? `${base.replace(/\/$/, '')}/v1/metrics`;
}

/**
 * @fastify/otel marks the request span failed whenever a route throws, including domain and
 * validation errors answered with a 4xx. By the OpenTelemetry HTTP conventions a client error
 * is not a server failure (the http server span already leaves it unset), so clear it here and
 * keep `{status=error}` for real failures. The recorded exception event stays on the span.
 */
class ClientErrorStatusProcessor implements SpanProcessor {
  onStart(): void {}

  onEnding(span: Span): void {
    if (span.instrumentationScope.name !== '@fastify/otel') return;
    if (span.status.code !== SpanStatusCode.ERROR) return;
    const status = span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE];
    // setStatus() ignores UNSET, and the span is still open here, so assign directly
    if (typeof status === 'number' && status < 500) {
      (span as { status: Span['status'] }).status = { code: SpanStatusCode.UNSET };
    }
  }

  onEnd(): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
