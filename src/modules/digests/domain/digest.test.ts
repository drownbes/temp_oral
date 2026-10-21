import { describe, expect, it } from 'vitest';
import { Digest, type DigestId } from './digest.ts';
import { InvalidDigestStateError, InvalidRunIdError } from './errors.ts';
import { parseRunId, runIdAt } from './run-id.ts';

const now = new Date('2026-10-21T06:00:00Z');
const begin = () =>
  Digest.begin({ id: 'd-1' as DigestId, ownerId: 'default', runId: parseRunId('2026-10-21'), now });
const collection = (itemCount: number) => ({
  exportKey: 'sources/exports/2026-10-21.jsonl',
  itemCount,
  failedSources: [{ sourceId: 's-9', reason: 'HTTP 404' }],
});
const usage = { inputTokens: 1000, outputTokens: 200 };

describe('Digest', () => {
  it('goes collecting → enriching → rendering → published', () => {
    const digest = begin();
    digest.recordCollection(collection(3), now);
    expect(digest.status).toBe('enriching');

    digest.enrichmentSubmitted('batch_1', now);
    digest.completeEnrichment({ analyzedCount: 2, failedItemCount: 1, usage }, now);
    expect(digest.status).toBe('rendering');

    digest.publish(now);
    expect(digest.toSnapshot()).toMatchObject({
      status: 'published',
      publishedAt: now,
      itemCount: 3,
      batchRef: 'batch_1',
      analyzedCount: 2,
      failedItemCount: 1,
      usage,
      failedSources: [{ sourceId: 's-9', reason: 'HTTP 404' }],
    });
    expect(digest.isFinished).toBe(true);
  });

  it('skips enrichment when nothing new was collected', () => {
    const digest = begin();
    digest.recordCollection(collection(0), now);
    expect(digest.status).toBe('rendering');
  });

  it('submits one batch only, and cannot complete without one', () => {
    const digest = begin();
    digest.recordCollection(collection(1), now);
    expect(() =>
      digest.completeEnrichment({ analyzedCount: 0, failedItemCount: 0, usage }, now),
    ).toThrow(InvalidDigestStateError);
    digest.enrichmentSubmitted('batch_1', now);
    expect(() => digest.enrichmentSubmitted('batch_2', now)).toThrow(InvalidDigestStateError);
  });

  it('can be superseded instead of published', () => {
    const digest = begin();
    digest.recordCollection(collection(0), now);
    digest.supersede(now);
    expect(digest.toSnapshot()).toMatchObject({ status: 'superseded', publishedAt: null });
    expect(digest.isFinished).toBe(true);
  });

  it('fails while unfinished and restarts from scratch', () => {
    const digest = begin();
    digest.recordCollection(collection(2), now);
    digest.enrichmentSubmitted('batch_1', now);
    digest.fail('batch rejected', now);
    expect(digest.toSnapshot()).toMatchObject({
      status: 'failed',
      failureReason: 'batch rejected',
    });

    digest.restart(now);
    expect(digest.toSnapshot()).toMatchObject({
      status: 'collecting',
      batchRef: null,
      itemCount: 0,
      failureReason: null,
    });
  });

  it('rejects out-of-order transitions', () => {
    const digest = begin();
    expect(() => digest.publish(now)).toThrow(InvalidDigestStateError);
    expect(() => digest.restart(now)).toThrow(InvalidDigestStateError);
    digest.recordCollection(collection(0), now);
    digest.publish(now);
    expect(() => digest.fail('late', now)).toThrow(InvalidDigestStateError);
  });
});

describe('run ids', () => {
  it('uses the calendar date in the digest time zone', () => {
    const instant = new Date('2026-10-21T23:30:00Z');
    expect(runIdAt(instant, 'UTC')).toBe('2026-10-21');
    expect(runIdAt(instant, 'Europe/Berlin')).toBe('2026-10-22');
    expect(runIdAt(instant, 'America/Los_Angeles')).toBe('2026-10-21');
  });

  it.each(['2026-02-30', '21.10.2026', ''])('rejects %s', (value) => {
    expect(() => parseRunId(value)).toThrow(InvalidRunIdError);
  });
});
