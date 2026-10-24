import { defaultPayloadConverter, type Headers } from '@temporalio/common';

/** Header in which @temporalio/interceptors-opentelemetry propagates the W3C trace context. */
const TRACE_HEADER = '_tracer-data';
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/;

/** Log fields linking a line to its trace, as the logger's own span mixin names them. */
export interface TraceLogAttributes {
  readonly trace_id: string;
  readonly span_id: string;
}

/**
 * The caller's trace context from Temporal headers: available for the whole execution, unlike
 * the active span. Safe in the workflow sandbox (no Node APIs, no OTel context).
 */
export function traceFromHeaders(headers: Headers): TraceLogAttributes | undefined {
  const payload = headers[TRACE_HEADER];
  if (!payload) return undefined;
  try {
    const carrier = defaultPayloadConverter.fromPayload<{ traceparent?: unknown }>(payload);
    const match =
      typeof carrier?.traceparent === 'string' ? TRACEPARENT.exec(carrier.traceparent) : null;
    return match?.[1] && match[2] ? { trace_id: match[1], span_id: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

/** Adds the trace fields unless a span active at log time already provided them. */
export function withTrace(
  attributes: Record<string, unknown>,
  trace: TraceLogAttributes | undefined,
): Record<string, unknown> {
  return trace && attributes.trace_id === undefined ? { ...attributes, ...trace } : attributes;
}
