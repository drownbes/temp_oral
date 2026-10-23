import { describe, expect, it } from 'vitest';
import type { DigestId } from './digest.ts';
import type { DigestEntry } from './digest-entry.ts';
import { markEarlierCoverage, type PublishedEntry } from './earlier-coverage.ts';
import type { RunId } from './run-id.ts';
import type { StoryCluster } from './story.ts';

const THRESHOLDS = { repeat: 0.97, followUp: 0.85 };

/** A unit vector at `degrees` in a plane: similarity between two is cos of the angle. */
const at = (degrees: number) => [
  Math.cos((degrees * Math.PI) / 180),
  Math.sin((degrees * Math.PI) / 180),
];

const entry = (itemId: string, embedding: number[] | null): DigestEntry => ({
  digestId: 'd-today' as DigestId,
  itemId,
  sourceId: `s-${itemId}`,
  sourceName: `Source ${itemId}`,
  url: `https://example.com/${itemId}`,
  title: `Title ${itemId}`,
  publishedAt: null,
  analysis: null,
  failure: null,
  embedding,
});

const shown = (itemId: string, embedding: number[], runId = '2026-10-22'): PublishedEntry => ({
  runId: runId as RunId,
  itemId,
  sourceName: `Earlier ${itemId}`,
  url: `https://example.org/${itemId}`,
  title: `Earlier title ${itemId}`,
  embedding,
});

const story = (...itemIds: string[]): StoryCluster => ({
  id: itemIds[0] ?? '',
  itemIds,
  headline: null,
  summary: null,
  earlier: null,
});

describe('markEarlierCoverage', () => {
  it('hides only near-copies; similar stories become follow-ups; the rest is news', () => {
    // cos 5° = 0.996, cos 20° = 0.940, cos 40° = 0.766
    const entries = [entry('copy', at(5)), entry('similar', at(20)), entry('new', at(40))];
    const [copy, similar, fresh] = markEarlierCoverage(
      [story('copy'), story('similar'), story('new')],
      entries,
      [shown('old', at(0))],
      THRESHOLDS,
    );

    expect(copy?.earlier).toEqual({
      kind: 'repeat',
      runId: '2026-10-22',
      sourceName: 'Earlier old',
      title: 'Earlier title old',
      url: 'https://example.org/old',
      similarity: 0.996,
    });
    expect(similar?.earlier).toMatchObject({ kind: 'follow-up', similarity: 0.94 });
    expect(fresh?.earlier).toBeNull();
  });

  it('keeps a story with one new article among copies, as a follow-up', () => {
    const entries = [entry('repost', at(0)), entry('new-angle', at(20))];
    const [marked] = markEarlierCoverage(
      [story('repost', 'new-angle')],
      entries,
      [shown('old', at(0))],
      THRESHOLDS,
    );
    expect(marked?.earlier).toMatchObject({ kind: 'follow-up', similarity: 1 });
  });

  it('does not call a story a repeat when one of its items has no embedding', () => {
    const entries = [entry('repost', at(0)), entry('unknown', null)];
    const [marked] = markEarlierCoverage(
      [story('repost', 'unknown')],
      entries,
      [shown('old', at(0))],
      THRESHOLDS,
    );
    expect(marked?.earlier?.kind).toBe('follow-up');
  });

  it('points at the first report when several earlier days match equally', () => {
    const [marked] = markEarlierCoverage(
      [story('a')],
      [entry('a', at(0))],
      [shown('later', at(0), '2026-10-22'), shown('first', at(0), '2026-10-20')],
      THRESHOLDS,
    );
    expect(marked?.earlier).toMatchObject({ runId: '2026-10-20', title: 'Earlier title first' });
  });

  it('leaves stories untouched without history or embeddings', () => {
    const clusters = [story('a')];
    expect(markEarlierCoverage(clusters, [entry('a', at(0))], [], THRESHOLDS)).toEqual(clusters);
    expect(
      markEarlierCoverage(clusters, [entry('a', null)], [shown('old', at(0))], THRESHOLDS),
    ).toEqual(clusters);
  });
});
