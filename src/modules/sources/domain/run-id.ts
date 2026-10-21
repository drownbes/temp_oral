import type { Brand } from '#shared/kernel/brand.ts';
import { InvalidRunIdError } from './errors.ts';

/** One collection run per day: `YYYY-MM-DD`. Groups the items handed to the digest. */
export type RunId = Brand<string, 'RunId'>;

const RUN_ID = /^\d{4}-\d{2}-\d{2}$/;

export function parseRunId(value: string): RunId {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !RUN_ID.test(value) ||
    Number.isNaN(date.getTime()) ||
    !date.toISOString().startsWith(value)
  ) {
    throw new InvalidRunIdError(`runId must be a date (YYYY-MM-DD), got "${value}"`);
  }
  return value as RunId;
}
