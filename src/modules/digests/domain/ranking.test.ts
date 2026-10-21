import { describe, expect, it } from 'vitest';
import type { DigestId } from './digest.ts';
import { type DigestEntry, itemAnalysis } from './digest-entry.ts';
import { InvalidProfileError } from './errors.ts';
import { InterestProfile } from './interest-profile.ts';
import { MAX_FEATURED, rankForDigest } from './ranking.ts';

const entry = (itemId: string, relevance: number | null, publishedAt = '2026-10-21T00:00:00Z') =>
  ({
    digestId: 'd-1' as DigestId,
    itemId,
    sourceId: 's-1',
    sourceName: 'Example',
    url: `https://example.com/${itemId}`,
    title: itemId,
    publishedAt: new Date(publishedAt),
    analysis:
      relevance === null ? null : { summary: 's', relevance, reason: 'r', tags: [] as string[] },
    failure: relevance === null ? 'not analysed' : null,
  }) satisfies DigestEntry;

const ids = (entries: readonly DigestEntry[]) => entries.map((e) => e.itemId);

describe('rankForDigest', () => {
  it('features relevant items by relevance; the rest go to "also noted", newest first', () => {
    const ranked = rankForDigest(
      [
        entry('low', 0.2, '2026-10-21T09:00:00Z'),
        entry('mid', 0.6),
        entry('top', 0.9),
        entry('failed', null, '2026-10-21T10:00:00Z'),
        entry('edge', 0.5),
      ],
      0.5,
    );
    expect(ids(ranked.featured)).toEqual(['top', 'mid', 'edge']);
    expect(ids(ranked.alsoNoted)).toEqual(['failed', 'low']);
  });

  it('caps the featured list and moves the overflow to "also noted"', () => {
    const many = Array.from({ length: MAX_FEATURED + 2 }, (_, i) => entry(`e${i}`, 0.9));
    const ranked = rankForDigest(many, 0.5);
    expect(ranked.featured).toHaveLength(MAX_FEATURED);
    expect(ranked.alsoNoted).toHaveLength(2);
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
