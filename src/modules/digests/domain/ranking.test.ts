import { describe, expect, it } from 'vitest';
import { clusterEntries, cosineSimilarity } from './clustering.ts';
import type { DigestId } from './digest.ts';
import { type DigestEntry, itemAnalysis } from './digest-entry.ts';
import { InvalidProfileError } from './errors.ts';
import { InterestProfile } from './interest-profile.ts';
import { MAX_FEATURED, rankStories, singleStories, toStories } from './ranking.ts';

const entry = (
  itemId: string,
  relevance: number | null,
  publishedAt = '2026-10-21T00:00:00Z',
  embedding: number[] | null = null,
  sourceId = 's-1',
) =>
  ({
    digestId: 'd-1' as DigestId,
    itemId,
    sourceId,
    sourceName: sourceId,
    url: `https://example.com/${itemId}`,
    title: itemId,
    publishedAt: new Date(publishedAt),
    analysis:
      relevance === null ? null : { summary: 's', relevance, reason: 'r', tags: [] as string[] },
    failure: relevance === null ? 'not analysed' : null,
    embedding,
  }) satisfies DigestEntry;

const ranked = (entries: DigestEntry[], threshold: number) =>
  rankStories(toStories(singleStories(entries), entries), threshold);
const ids = (stories: readonly { cluster: { id: string } }[]) => stories.map((s) => s.cluster.id);

describe('rankStories', () => {
  it('features relevant stories by relevance; the rest go to "also noted", newest first', () => {
    const result = ranked(
      [
        entry('low', 0.2, '2026-10-21T09:00:00Z'),
        entry('mid', 0.6),
        entry('top', 0.9),
        entry('failed', null, '2026-10-21T10:00:00Z'),
        entry('edge', 0.5),
      ],
      0.5,
    );
    expect(ids(result.featured)).toEqual(['top', 'mid', 'edge']);
    expect(ids(result.alsoNoted)).toEqual(['failed', 'low']);
  });

  it('caps the featured list and moves the overflow to "also noted"', () => {
    const many = Array.from({ length: MAX_FEATURED + 2 }, (_, i) => entry(`e${i}`, 0.9));
    const result = ranked(many, 0.5);
    expect(result.featured).toHaveLength(MAX_FEATURED);
    expect(result.alsoNoted).toHaveLength(2);
  });

  it('ranks a story by its most relevant item', () => {
    const entries = [entry('a', 0.3), entry('b', 0.8), entry('c', 0.6)];
    const stories = toStories(
      [
        { id: 'a', itemIds: ['a', 'b'], headline: null, summary: null },
        { id: 'c', itemIds: ['c'], headline: null, summary: null },
      ],
      entries,
    );
    expect(stories.map((s) => s.relevance)).toEqual([0.8, 0.6]);
    expect(ids(rankStories(stories, 0.7).featured)).toEqual(['a']);
  });
});

describe('clusterEntries', () => {
  it('groups coverage from other sources around the most relevant item; leads go first', () => {
    const clusters = clusterEntries(
      [
        entry('plasma-9to5', 0.6, undefined, [0.95, 0.31, 0], '9to5'),
        entry('cosmic', 0.8, undefined, [0, 1, 0], 'phoronix'),
        entry('plasma-phoronix', 0.7, undefined, [1, 0, 0], 'phoronix'),
        entry('no-vector', 0.9, undefined, null, 'gizmos'),
      ],
      0.9,
    );
    expect(clusters.map((c) => c.itemIds)).toEqual([
      ['no-vector'],
      ['cosmic'],
      ['plasma-phoronix', 'plasma-9to5'],
    ]);
    expect(clusters[2]).toEqual({
      id: 'plasma-phoronix',
      itemIds: ['plasma-phoronix', 'plasma-9to5'],
      headline: null,
      summary: null,
    });
  });

  it('never groups two items of the same source (same topic is not the same story)', () => {
    const clusters = clusterEntries(
      [
        entry('xfs', 0.9, undefined, [1, 0], 'phoronix'),
        entry('btrfs', 0.8, undefined, [0.99, 0.1], 'phoronix'),
      ],
      0.7,
    );
    expect(clusters.map((c) => c.itemIds)).toEqual([['xfs'], ['btrfs']]);
  });

  it('takes the most similar item of each other source', () => {
    // Both 9to5 items pass the threshold; the closer one joins, the other stays alone
    const clusters = clusterEntries(
      [
        entry('cosmic', 0.9, undefined, [1, 0], 'phoronix'),
        entry('distro-with-cosmic', 0.8, undefined, [0.8, 0.6], '9to5'),
        entry('cosmic-9to5', 0.5, undefined, [0.95, 0.31], '9to5'),
      ],
      0.7,
    );
    expect(clusters.map((c) => c.itemIds)).toEqual([
      ['cosmic', 'cosmic-9to5'],
      ['distro-with-cosmic'],
    ]);
  });

  it('compares to the lead only, so similar-to-a-member items do not chain in', () => {
    // b is close to both a and c, but a and c are not close: a takes b, c stays alone
    const clusters = clusterEntries(
      [
        entry('a', 0.9, undefined, [1, 0], 's-a'),
        entry('b', 0.8, undefined, [Math.SQRT1_2, Math.SQRT1_2], 's-b'),
        entry('c', 0.7, undefined, [0, 1], 's-c'),
      ],
      0.7,
    );
    expect(clusters.map((c) => c.itemIds)).toEqual([['a', 'b'], ['c']]);
  });

  it('measures cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });
});

describe('itemAnalysis', () => {
  it('clamps relevance and tidies tags', () => {
    expect(
      itemAnalysis({
        summary: ' S ',
        relevance: 1.7,
        reason: 'r',
        tags: ['Linux', 'linux', ' ', 'GPU'],
      }),
    ).toEqual({ summary: 'S', relevance: 1, reason: 'r', tags: ['linux', 'gpu'] });
    expect(
      itemAnalysis({ summary: 's', relevance: Number.NaN, reason: '', tags: [] }).relevance,
    ).toBe(0);
  });
});

describe('InterestProfile', () => {
  const now = new Date('2026-10-21T06:00:00Z');

  it('starts empty with the default threshold and validates changes', () => {
    const profile = InterestProfile.initial('default', now);
    expect(profile.toSnapshot()).toMatchObject({ interests: '', relevanceThreshold: 0.5 });

    profile.change({ interests: '  Linux kernel, GPUs  ' }, now);
    expect(profile.toSnapshot()).toMatchObject({
      interests: 'Linux kernel, GPUs',
      relevanceThreshold: 0.5,
    });
    expect(() => profile.change({ relevanceThreshold: 1.5 }, now)).toThrow(InvalidProfileError);
    expect(() => profile.change({ interests: 'x'.repeat(4001) }, now)).toThrow(InvalidProfileError);
  });
});
