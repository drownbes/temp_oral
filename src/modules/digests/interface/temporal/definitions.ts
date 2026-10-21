/** Temporal wiring internal to the digests context. */
export const DIGESTS_TASK_QUEUE = 'digests';
export const DAILY_DIGEST_WORKFLOW = 'dailyDigestWorkflow';
export const DAILY_DIGEST_SCHEDULE = 'daily-digest';

/**
 * Waits between checks of the LLM batch; the last one repeats until it finishes. Small
 * batches often finish within minutes, so check early, then settle into a slow pace for
 * batches that take hours (up to 24h).
 */
export const BATCH_POLL_INTERVALS: readonly string[] = [
  '1 minute',
  '2 minutes',
  '5 minutes',
  '10 minutes',
];

/** The wait before check number `attempt + 1` (0-based), repeating the last interval. */
export const pollDelay = (intervals: readonly string[], attempt: number): string =>
  intervals[Math.min(attempt, intervals.length - 1)] ?? '10 minutes';

export interface DailyDigestInput {
  readonly ownerId: string;
  /** Scheduled runs leave it out: the day is derived from the start time. */
  readonly runId?: string;
  /** Override of BATCH_POLL_INTERVALS, for tests. */
  readonly pollIntervals?: readonly string[];
}

export const digestWorkflowId = (ownerId: string, runId: string) => `digest-${ownerId}-${runId}`;
