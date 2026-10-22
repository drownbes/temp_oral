import { describe, expect, it } from 'vitest';
import { planCollection } from './collection.ts';
import { InvalidRunIdError } from './errors.ts';
import { itemIdFor } from './item.ts';
import { parseRunId } from './run-id.ts';
import { Source, type SourceId } from './source.ts';

const now = new Date('2026-10-21T06:00:00Z');
const source = () =>
  Source.create({
    id: 'src-1' as SourceId,
    ownerId: 'default',
    name: 'Blog',
    url: 'https://example.com/blog/feed.xml',
    fetchMode: 'http',
    settings: { kind: 'feed', fetchArticles: true },
    now,
  });

describe('planCollection', () => {
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
  const entries = [
    { url: '/posts/1?utm_source=rss', title: 'One', publishedAt: hoursAgo(2) },
    { url: 'https://example.com/posts/1', title: 'One again', publishedAt: hoursAgo(2) },
    { url: 'https://example.com/posts/2', title: 'Two', publishedAt: hoursAgo(30) },
    { url: 'https://example.com/posts/3', title: 'Undated', publishedAt: null },
    { url: 'mailto:me@example.com', title: 'Not an article', publishedAt: null },
  ];

  it('on the first collection, keeps the last 24 hours as new and baselines the rest', () => {
    const plan = planCollection(source(), entries, new Set(), now);
    expect(plan.firstCollection).toBe(true);
    expect(plan.newEntries.map((e) => [e.url, e.title, e.baseline])).toEqual([
      ['https://example.com/posts/1', 'One', false],
      ['https://example.com/posts/2', 'Two', true],
      ['https://example.com/posts/3', 'Undated', true],
    ]);
  });

  it('keeps only unknown entries once baselined, all of them new whatever their date', () => {
    const baselined = source();
    baselined.recordSuccess({ etag: null, lastModified: null }, now);

    const plan = planCollection(baselined, entries, new Set(['https://example.com/posts/1']), now);
    expect(plan.firstCollection).toBe(false);
    expect(plan.newEntries.map((e) => [e.title, e.baseline])).toEqual([
      ['Two', false],
      ['Undated', false],
    ]);
  });
});

describe('itemIdFor', () => {
  it('is deterministic per source and URL, and a valid UUID', async () => {
    const a = await itemIdFor('src-1' as SourceId, 'https://example.com/posts/1');
    expect(a).toBe(await itemIdFor('src-1' as SourceId, 'https://example.com/posts/1'));
    expect(a).not.toBe(await itemIdFor('src-2' as SourceId, 'https://example.com/posts/1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('parseRunId', () => {
  it('accepts calendar dates', () => {
    expect(parseRunId('2026-10-21')).toBe('2026-10-21');
  });

  it.each(['2026-02-30', '2026-10-21T00:00', '21-10-2026', ''])('rejects %s', (value) => {
    expect(() => parseRunId(value)).toThrow(InvalidRunIdError);
  });
});
