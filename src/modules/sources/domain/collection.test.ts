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
    settings: { kind: 'feed' },
    now,
  });

describe('planCollection', () => {
  const entries = [
    { url: '/posts/1?utm_source=rss', title: 'One' },
    { url: 'https://example.com/posts/1', title: 'One again' },
    { url: 'https://example.com/posts/2', title: 'Two' },
    { url: 'mailto:me@example.com', title: 'Not an article' },
  ];

  it('marks everything as baseline on the first collection', () => {
    const plan = planCollection(source(), entries, new Set());
    expect(plan.baseline).toBe(true);
    expect(plan.newEntries).toEqual([
      { url: 'https://example.com/posts/1', title: 'One' },
      { url: 'https://example.com/posts/2', title: 'Two' },
    ]);
  });

  it('keeps only unknown entries once baselined', () => {
    const baselined = source();
    baselined.recordSuccess({ etag: null, lastModified: null }, now);

    const plan = planCollection(baselined, entries, new Set(['https://example.com/posts/1']));
    expect(plan.baseline).toBe(false);
    expect(plan.newEntries.map((e) => e.title)).toEqual(['Two']);
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
