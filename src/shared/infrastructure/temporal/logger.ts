import type { LogLevel, LogMetadata, Logger as TemporalLogger } from '@temporalio/common';
import type { Logger } from '../logger.ts';

const LEVELS = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const satisfies Record<LogLevel, string>;

/**
 * Routes Temporal SDK, workflow (`log` from @temporalio/workflow, via sinks) and activity logs
 * into pino. Workflow/activity metadata (workflowId, runId, activityType, trace_id, ...) is kept.
 */
export class PinoTemporalLogger implements TemporalLogger {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    // The SDK reports failures as `error`; pino only serialises message, stack and cause of
    // an Error under `err`, where `err.type` is the class name. An ApplicationFailure's own
    // type (the domain error code) is kept as `failureType`. The task token is an opaque blob.
    const { error, taskToken: _taskToken, ...rest } = meta ?? {};
    if (error === undefined) {
      this.#logger[LEVELS[level]](rest, message);
      return;
    }
    const failureType = (error as { type?: unknown }).type;
    this.#logger[LEVELS[level]](
      typeof failureType === 'string'
        ? { ...rest, err: error, failureType }
        : { ...rest, err: error },
      message,
    );
  }
  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }
  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }
  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }
  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }
  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
}
