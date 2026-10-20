import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';
import type { Telemetry } from '../telemetry/telemetry.ts';

export interface TemporalConnectionConfig {
  readonly address: string;
  readonly namespace: string;
  readonly apiKey: string | undefined;
}

/** Connection options shared by the client (API) and worker connections. */
export function connectionOptions(config: TemporalConnectionConfig) {
  return config.apiKey
    ? { address: config.address, tls: true, apiKey: config.apiKey }
    : { address: config.address };
}

/**
 * Propagates trace context API -> workflow -> activity -> child workflow and exports
 * workflow spans through the process's span processor.
 */
export function temporalTracingPlugin(telemetry: Telemetry): OpenTelemetryPlugin {
  type PluginOptions = ConstructorParameters<typeof OpenTelemetryPlugin>[0];
  return new OpenTelemetryPlugin({
    resource: telemetry.resource as unknown as PluginOptions['resource'],
    spanProcessor: new WorkflowSpanAdapter(
      telemetry.spanProcessor,
    ) as unknown as PluginOptions['spanProcessor'],
  });
}

/** Span shape produced by @temporalio/interceptors-opentelemetry, which is built on OTel SDK 1.x. */
type LegacyReadableSpan = ReadableSpan & {
  instrumentationLibrary?: ReadableSpan['instrumentationScope'];
  parentSpanId?: string;
};

/**
 * Workflow spans are recorded inside the workflow sandbox with OTel SDK 1.x and replayed into
 * our processor on the main thread. SDK 2.x renamed `instrumentationLibrary` and replaced
 * `parentSpanId`, and the OTLP exporter crashes on the old shape, so translate it here.
 * Remove once Temporal's interceptors move to OTel SDK 2.x.
 */
class WorkflowSpanAdapter implements SpanProcessor {
  readonly #inner: SpanProcessor;

  constructor(inner: SpanProcessor) {
    this.#inner = inner;
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: LegacyReadableSpan): void {
    const spanContext = span.spanContext();
    const parentSpanContext =
      span.parentSpanContext ??
      (span.parentSpanId
        ? {
            traceId: spanContext.traceId,
            spanId: span.parentSpanId,
            traceFlags: 1,
            isRemote: false,
          }
        : undefined);

    this.#inner.onEnd({
      ...span,
      spanContext: () => spanContext,
      instrumentationScope: span.instrumentationScope ??
        span.instrumentationLibrary ?? { name: '@temporalio/interceptor-workflow' },
      parentSpanContext,
    });
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush();
  }

  /** The wrapped processor is owned (and shut down) by the telemetry SDK. */
  async shutdown(): Promise<void> {}
}
