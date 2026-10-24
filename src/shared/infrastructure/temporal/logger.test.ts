import { Writable } from 'node:stream';
import { ApplicationFailure } from '@temporalio/common';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { PinoTemporalLogger } from './logger.ts';

function capture(): { logger: PinoTemporalLogger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { logger: new PinoTemporalLogger(pino({ base: null }, stream)), lines };
}

describe('PinoTemporalLogger', () => {
  it('logs the SDK error with its message and stack', () => {
    const { logger, lines } = capture();
    const failure = ApplicationFailure.create({
      type: 'SOURCE_FETCH_FAILED',
      message: 'HTTP 403 from https://example.com',
      nonRetryable: true,
    });

    logger.warn('Activity failed', { error: failure, durationMs: 14, activityType: 'collect' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'Activity failed',
      durationMs: 14,
      activityType: 'collect',
      failureType: 'SOURCE_FETCH_FAILED',
      err: {
        type: 'ApplicationFailure',
        message: 'HTTP 403 from https://example.com',
        stack: expect.stringContaining('HTTP 403'),
      },
    });
    expect(lines[0]).not.toHaveProperty('error');
  });

  it('leaves out the task token', () => {
    const { logger, lines } = capture();

    logger.info('Activity started', { taskToken: 'CiQwMWEx', activityId: '1' });

    expect(lines[0]).toMatchObject({ activityId: '1' });
    expect(lines[0]).not.toHaveProperty('taskToken');
  });
});
