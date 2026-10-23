import type { Brand } from '#shared/kernel/brand.ts';
import { InvalidRunIdError } from './errors.ts';

/** The day a digest covers, `YYYY-MM-DD`; also the sources collection run it consumes. */
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

/** The run `days` calendar days before `runId`. */
export function daysBefore(runId: RunId, days: number): RunId {
  const date = new Date(`${runId}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return parseRunId(date.toISOString().slice(0, 10));
}

/** The calendar date of `instant` in `timeZone`, so a 06:00 Europe/Berlin run is "today" there. */
export function runIdAt(instant: Date, timeZone: string): RunId {
  // en-CA formats dates as YYYY-MM-DD
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parseRunId(date);
}
