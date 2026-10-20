import { isSpanContextValid, trace } from '@opentelemetry/api';
import { type Logger, pino, stdTimeFunctions } from 'pino';
import type { AppConfig } from './config.ts';

export type { Logger };

/**
 * Structured JSON logger writing to stdout. In production the log agent ships stdout to
 * VictoriaLogs; locally scripts/dev/ship-logs.ts does the same.
 * Every line logged inside an active span carries trace_id/span_id for log <-> trace correlation.
 */
export function createLogger(config: AppConfig, component: string): Logger {
  return pino({
    level: config.log.level,
    base: { service: config.serviceName, component, env: config.env },
    messageKey: 'msg',
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const spanContext = trace.getActiveSpan()?.spanContext();
      if (!spanContext || !isSpanContextValid(spanContext)) return {};
      return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.secret'],
      censor: '[redacted]',
    },
  });
}
