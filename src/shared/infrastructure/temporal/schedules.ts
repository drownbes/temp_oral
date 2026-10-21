import { type Client, ScheduleAlreadyRunning, ScheduleOverlapPolicy } from '@temporalio/client';
import type { Logger } from '../logger.ts';

/** A Temporal Schedule a module wants to exist; the worker creates or updates it at startup. */
export interface ScheduleDefinition {
  readonly scheduleId: string;
  readonly cron: string;
  /** IANA time zone the cron expression is evaluated in. */
  readonly timezone: string;
  readonly workflowType: string;
  readonly taskQueue: string;
  readonly args: readonly unknown[];
}

/**
 * Makes each schedule match its definition. Idempotent, so every worker replica can run it;
 * config changes (cron, time zone, args) take effect on the next deploy.
 */
export async function upsertSchedules(
  client: Client,
  schedules: readonly ScheduleDefinition[],
  logger: Logger,
): Promise<void> {
  for (const schedule of schedules) {
    const spec = { cronExpressions: [schedule.cron], timezone: schedule.timezone };
    const action = {
      type: 'startWorkflow' as const,
      workflowType: schedule.workflowType,
      taskQueue: schedule.taskQueue,
      args: [...schedule.args],
    };
    try {
      await client.schedule.create({
        scheduleId: schedule.scheduleId,
        spec,
        action,
        policies: { overlap: ScheduleOverlapPolicy.ALLOW_ALL },
      });
      logger.info({ scheduleId: schedule.scheduleId, cron: schedule.cron }, 'schedule created');
    } catch (err) {
      if (!(err instanceof ScheduleAlreadyRunning)) throw err;
      await client.schedule
        .getHandle(schedule.scheduleId)
        .update((previous) => ({ ...previous, spec, action }));
      logger.info({ scheduleId: schedule.scheduleId, cron: schedule.cron }, 'schedule updated');
    }
  }
}
