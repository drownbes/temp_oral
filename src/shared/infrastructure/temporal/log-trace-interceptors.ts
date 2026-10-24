import { fileURLToPath } from 'node:url';
import { isSpanContextValid, trace as otelTrace } from '@opentelemetry/api';
import type { ActivityInterceptorsFactory, WorkerInterceptors } from '@temporalio/worker';
import { type TraceLogAttributes, traceFromHeaders, withTrace } from './trace-headers.ts';

/**
 * Links the SDK's own activity logs ("Activity failed") to the trace. The SDK writes them after
 * the activity span has ended, so the OpenTelemetry interceptor has no span to take ids from.
 */
const activityLogTrace: ActivityInterceptorsFactory = () => {
  let trace: TraceLogAttributes | undefined;
  return {
    inbound: {
      execute(input, next) {
        const span = otelTrace.getActiveSpan()?.spanContext();
        trace =
          span && isSpanContextValid(span)
            ? { trace_id: span.traceId, span_id: span.spanId }
            : traceFromHeaders(input.headers);
        return next(input);
      },
    },
    outbound: {
      getLogAttributes(input, next) {
        return withTrace(next(input), trace);
      },
    },
  };
};

/** Worker interceptors that keep trace ids on every Temporal SDK log line. */
export function logTraceInterceptors(): WorkerInterceptors {
  return {
    activity: [activityLogTrace],
    workflowModules: [fileURLToPath(new URL('./workflow-log-interceptors.ts', import.meta.url))],
  };
}
