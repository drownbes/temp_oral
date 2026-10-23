import { describe, expect, it } from 'vitest';
import { ArchivedSourceError, InvalidSourceError } from './errors.ts';
import { Source, type SourceId, sourceSettings } from './source.ts';

const now = new Date('2026-10-21T06:00:00Z');
const later = new Date('2026-10-22T06:00:00Z');
const create = (overrides: Partial<Parameters<typeof Source.create>[0]> = {}) =>
  Source.create({
    id: 'src-1' as SourceId,
    ownerId: 'default',
    name: ' Example blog ',
    url: 'https://Example.com/feed.xml#top',
    fetchMode: 'http',
    settings: { kind: 'feed', fetchArticles: true },
    now,
    ...overrides,
  });

describe('Source', () => {
  it('starts enabled, not baselined, with a canonical URL and trimmed name', () => {
    expect(create().toSnapshot()).toMatchObject({
      name: 'Example blog',
      url: 'https://example.com/feed.xml',
      enabled: true,
      baselinedAt: null,
      consecutiveFailures: 0,
    });
    expect(create().isCollectable).toBe(true);
  });

  it.each([
    [{ name: ' ' }, 'name is required'],
    [{ url: 'ftp://example.com/feed' }, 'url must be an absolute http(s) URL'],
    [{ url: '/feed.xml' }, 'url must be an absolute http(s) URL'],
    [{ ownerId: '' }, 'ownerId is required'],
  ])('rejects invalid input %o', (overrides, message) => {
    expect(() => create(overrides)).toThrow(new InvalidSourceError(message));
  });

  it('is baselined by the first success and resets failures on success', () => {
    const source = create();
    source.recordFailure('timeout', now);
    source.recordFailure('timeout', now);
    expect(source.toSnapshot()).toMatchObject({ consecutiveFailures: 2, lastError: 'timeout' });
    expect(source.isBaselined).toBe(false);

    source.recordSuccess({ etag: '"v1"', lastModified: null }, later);
    expect(source.toSnapshot()).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
      baselinedAt: later,
      validators: { etag: '"v1"', lastModified: null },
    });
  });

  it('keeps the first baseline date on later successes', () => {
    const source = create();
    source.recordSuccess({ etag: null, lastModified: null }, now);
    source.recordSuccess({ etag: null, lastModified: null }, later);
    expect(source.toSnapshot().baselinedAt).toEqual(now);
  });

  it('starts over when the URL or kind changes, but not on a rename', () => {
    const source = create();
    source.recordSuccess({ etag: '"v1"', lastModified: null }, now);

    source.update({ name: 'Renamed', enabled: false }, later);
    expect(source.isBaselined).toBe(true);
    expect(source.isCollectable).toBe(false);

    source.update({ url: 'https://example.com/atom.xml' }, later);
    expect(source.toSnapshot()).toMatchObject({
      url: 'https://example.com/atom.xml',
      baselinedAt: null,
      validators: { etag: null, lastModified: null },
    });
  });

  it('keeps a wait selector only for browser sources', () => {
    expect(create({ waitForSelector: 'main' }).toSnapshot().waitForSelector).toBeNull();

    const source = create({ fetchMode: 'browser', waitForSelector: ' .news-list ' });
    expect(source.toSnapshot().waitForSelector).toBe('.news-list');

    source.update({ name: 'Renamed' }, later);
    expect(source.toSnapshot().waitForSelector).toBe('.news-list');

    source.update({ waitForSelector: ' ' }, later);
    expect(source.toSnapshot().waitForSelector).toBeNull();

    source.update({ waitForSelector: 'article' }, later);
    source.update({ fetchMode: 'http' }, later);
    expect(source.toSnapshot()).toMatchObject({ fetchMode: 'http', waitForSelector: null });
  });

  it('rejects an overly long wait selector', () => {
    expect(() => create({ fetchMode: 'browser', waitForSelector: 'a'.repeat(501) })).toThrow(
      new InvalidSourceError('waitForSelector is too long'),
    );
  });

  it('cannot be changed once archived', () => {
    const source = create();
    source.archive(later);
    expect(source.isCollectable).toBe(false);
    expect(() => source.update({ name: 'x' }, later)).toThrow(ArchivedSourceError);
  });
});

describe('sourceSettings', () => {
  it('keeps only the options of the kind', () => {
    expect(sourceSettings('feed', { contentSelector: 'main' })).toEqual({
      kind: 'feed',
      fetchArticles: true,
    });
    expect(sourceSettings('feed', { fetchArticles: false })).toEqual({
      kind: 'feed',
      fetchArticles: false,
    });
    expect(sourceSettings('listing', { linkSelector: ' a.post ', urlPattern: '' })).toEqual({
      kind: 'listing',
      linkSelector: 'a.post',
      urlPattern: null,
    });
  });

  it('rejects an invalid URL pattern', () => {
    expect(() => sourceSettings('listing', { urlPattern: '(' })).toThrow(InvalidSourceError);
  });
});
