// Workflow interceptors module, bundled into the workflow sandbox: no Node APIs.
import type { WorkflowInterceptorsFactory } from '@temporalio/workflow';
import { type TraceLogAttributes, traceFromHeaders, withTrace } from './trace-headers.ts';

/**
 * Links the SDK's own workflow logs ("Workflow failed") to the trace. The SDK writes them after
 * the workflow span has ended, so the OpenTelemetry interceptor has no span to take ids from.
 */
export const interceptors: WorkflowInterceptorsFactory = () => {
  let trace: TraceLogAttributes | undefined;
  return {
    inbound: [
      {
        execute(input, next) {
          trace = traceFromHeaders(input.headers);
          return next(input);
        },
      },
    ],
    outbound: [
      {
        getLogAttributes(input, next) {
          return withTrace(next(input), trace);
        },
      },
    ],
  };
};
