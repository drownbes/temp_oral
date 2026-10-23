import { describe, expect, it } from 'vitest';
import { Digest, type DigestId } from './digest.ts';
import { InvalidDigestStateError, InvalidRunIdError } from './errors.ts';
import { daysBefore, parseRunId, runIdAt } from './run-id.ts';

const now = new Date('2026-10-21T06:00:00Z');
const begin = () =>
  Digest.begin({ id: 'd-1' as DigestId, ownerId: 'default', runId: parseRunId('2026-10-21'), now });
const collection = (itemCount: number) => ({
  exportKey: 'sources/exports/2026-10-21.jsonl',
  itemCount,
  failedSources: [{ sourceId: 's-9', reason: 'HTTP 404' }],
});
const refs = { analysisBatchRef: 'batch_a', embeddingBatchRef: 'batch_e' };
const usage = { inputTokens: 1000, outputTokens: 200 };
const cluster = {
  id: 'i-1',
  itemIds: ['i-1', 'i-2'],
  headline: null,
  summary: null,
  earlier: null,
};
const enrichment = { analyzedCount: 2, failedItemCount: 1, clusters: [cluster], usage };

describe('Digest', () => {
  it('goes collecting → enriching → synthesizing → rendering → published', () => {
    const digest = begin();
    digest.recordCollection(collection(3), now);
    expect(digest.status).toBe('enriching');

    digest.enrichmentSubmitted(refs, now);
    digest.completeEnrichment(enrichment, now);
    expect(digest.status).toBe('synthesizing');

    digest.synthesisSubmitted('batch_s', now);
    digest.completeSynthesis(
      {
        stories: new Map([['i-1', { headline: 'Merged', summary: 'Both say so.' }]]),
        overview: '  A quiet day.  ',
        usage: { inputTokens: 50, outputTokens: 20 },
      },
      now,
    );
    expect(digest.status).toBe('rendering');

    digest.publish(now);
    expect(digest.toSnapshot()).toMatchObject({
      status: 'published',
      publishedAt: now,
      itemCount: 3,
      ...refs,
      synthesisBatchRef: 'batch_s',
      analyzedCount: 2,
      failedItemCount: 1,
      clusters: [{ ...cluster, headline: 'Merged', summary: 'Both say so.' }],
      overview: 'A quiet day.',
      usage: { inputTokens: 1050, outputTokens: 220 },
    });
    expect(digest.isFinished).toBe(true);
  });

  it('skips enrichment when nothing new was collected', () => {
    const digest = begin();
    digest.recordCollection(collection(0), now);
    expect(digest.status).toBe('rendering');
  });

  it('submits each batch once, and cannot complete without them', () => {
    const digest = begin();
    digest.recordCollection(collection(1), now);
    expect(() => digest.completeEnrichment(enrichment, now)).toThrow(InvalidDigestStateError);
    digest.enrichmentSubmitted(refs, now);
    expect(() => digest.enrichmentSubmitted(refs, now)).toThrow(InvalidDigestStateError);
    digest.completeEnrichment(enrichment, now);
    digest.synthesisSubmitted('batch_s', now);
    expect(() => digest.synthesisSubmitted('batch_t', now)).toThrow(InvalidDigestStateError);
  });

  it('can complete synthesis without a batch (nothing to synthesise)', () => {
    const digest = begin();
    digest.recordCollection(collection(1), now);
    digest.enrichmentSubmitted(refs, now);
    digest.completeEnrichment(enrichment, now);
    digest.completeSynthesis({ stories: new Map(), overview: '', usage }, now);
    expect(digest.toSnapshot()).toMatchObject({ status: 'rendering', overview: null });
    expect(digest.toSnapshot().clusters).toEqual([cluster]);
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
    digest.enrichmentSubmitted(refs, now);
    digest.fail('batch rejected', now);
    expect(digest.toSnapshot()).toMatchObject({
      status: 'failed',
      failureReason: 'batch rejected',
    });

    digest.restart(now);
    expect(digest.toSnapshot()).toMatchObject({
      status: 'collecting',
      analysisBatchRef: null,
      embeddingBatchRef: null,
      clusters: [],
      itemCount: 0,
      failureReason: null,
    });
  });

  it('rejects out-of-order transitions', () => {
    const digest = begin();
    expect(() => digest.publish(now)).toThrow(InvalidDigestStateError);
    expect(() => digest.restart(now)).toThrow(InvalidDigestStateError);
    expect(() => digest.synthesisSubmitted('batch_s', now)).toThrow(InvalidDigestStateError);
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

  it('counts days back across month and year ends', () => {
    expect(daysBefore(parseRunId('2026-10-23'), 7)).toBe('2026-10-16');
    expect(daysBefore(parseRunId('2026-03-02'), 2)).toBe('2026-02-28');
    expect(daysBefore(parseRunId('2027-01-01'), 1)).toBe('2026-12-31');
    expect(daysBefore(parseRunId('2026-10-23'), 0)).toBe('2026-10-23');
  });

  it.each(['2026-02-30', '21.10.2026', ''])('rejects %s', (value) => {
    expect(() => parseRunId(value)).toThrow(InvalidRunIdError);
  });
});
