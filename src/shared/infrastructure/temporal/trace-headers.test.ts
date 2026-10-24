import { defaultPayloadConverter } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import { traceFromHeaders, withTrace } from './trace-headers.ts';

const TRACE_ID = '600427772141f11708ee8b6fee899fce';
const SPAN_ID = 'e5c94844e774dcfe';

describe('traceFromHeaders', () => {
  it('reads the W3C context the OpenTelemetry interceptors propagate', () => {
    const headers = {
      '_tracer-data': defaultPayloadConverter.toPayload({
        traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      }),
    };

    expect(traceFromHeaders(headers)).toEqual({ trace_id: TRACE_ID, span_id: SPAN_ID });
  });

  it('is undefined without a usable trace header', () => {
    expect(traceFromHeaders({})).toBeUndefined();
    expect(
      traceFromHeaders({
        '_tracer-data': defaultPayloadConverter.toPayload({ traceparent: 'garbage' }),
      }),
    ).toBeUndefined();
  });
});

describe('withTrace', () => {
  const trace = { trace_id: TRACE_ID, span_id: SPAN_ID };

  it('adds the trace to attributes without one', () => {
    expect(withTrace({ workflowId: 'w' }, trace)).toEqual({ workflowId: 'w', ...trace });
  });

  it('keeps ids from a span that was active when logging', () => {
    const active = { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) };
    expect(withTrace(active, trace)).toEqual(active);
  });
});
