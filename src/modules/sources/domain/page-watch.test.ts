import { describe, expect, it } from 'vitest';
import { isListingArticle, wantsArticlePage } from './article.ts';
import { InvalidSourceError } from './errors.ts';
import {
  changeItemUrl,
  changeText,
  contentHash,
  describeChange,
  normalizePageText,
  PageSnapshot,
} from './page-watch.ts';
import { type SourceId, sourceSettings } from './source.ts';

describe('page watch', () => {
  it('normalises whitespace and blank lines, so re-indented markup is not a change', () => {
    expect(normalizePageText('  Kernel   7.4  \n\n\n\t rc1 released \n')).toBe(
      'Kernel 7.4\nrc1 released',
    );
  });

  it('hashes equal text equally and different text differently', async () => {
    expect(await contentHash('a\nb')).toBe(await contentHash('a\nb'));
    expect(await contentHash('a\nb')).not.toBe(await contentHash('a\nc'));
    expect(await contentHash('a')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('describes added and removed lines, ignoring lines that only moved', () => {
    const change = describeChange(
      'stable: 7.3.4\nlongterm: 6.12.40\nmainline: 7.4-rc1',
      'mainline: 7.4-rc2\nstable: 7.3.5\nlongterm: 6.12.40',
    );
    expect(change).toEqual({
      added: ['mainline: 7.4-rc2', 'stable: 7.3.5'],
      removed: ['stable: 7.3.4', 'mainline: 7.4-rc1'],
    });
    expect(changeText(change)).toBe(
      'Added:\n+ mainline: 7.4-rc2\n+ stable: 7.3.5\nRemoved:\n- stable: 7.3.4\n- mainline: 7.4-rc1',
    );
  });

  it('caps long change descriptions', () => {
    const added = Array.from({ length: 65 }, (_, i) => `line ${i}`);
    const text = changeText({ added, removed: [] });
    expect(text.split('\n')).toHaveLength(62);
    expect(text).toContain('(5 more)');
  });

  it('reports a change only for the same URL with a different hash', () => {
    const snapshot = PageSnapshot.take({
      sourceId: 's-1' as SourceId,
      url: 'https://kernel.org/',
      contentHash: 'aaa',
      text: 'x',
      takenAt: new Date(),
    });
    expect(snapshot.changedTo('https://kernel.org/', 'bbb')).toBe(true);
    expect(snapshot.changedTo('https://kernel.org/', 'aaa')).toBe(false);
    expect(snapshot.changedTo('https://other.org/', 'bbb')).toBe(false);
    expect(snapshot.isOf('https://other.org/')).toBe(false);
    expect(changeItemUrl('https://kernel.org/', 'bbb')).toBe('https://kernel.org/#change-bbb');
  });
});

describe('listing sources', () => {
  it('need a link selector or a URL pattern', () => {
    expect(() => sourceSettings('listing', {})).toThrow(InvalidSourceError);
    expect(sourceSettings('listing', { urlPattern: '/blog/\\d{4}-' })).toMatchObject({
      urlPattern: '/blog/\\d{4}-',
    });
  });

  it('count same-site links other than the listing itself, matching the pattern', () => {
    const listing = 'https://www.tweag.io/blog/';
    expect(isListingArticle('https://tweag.io/blog/2026-10-08-x/', listing, '/blog/\\d{4}-')).toBe(
      true,
    );
    expect(isListingArticle('https://www.tweag.io/blog/tags/nix/', listing, '/blog/\\d{4}-')).toBe(
      false,
    );
    expect(isListingArticle('https://twitter.com/tweag', listing, null)).toBe(false);
    expect(isListingArticle('https://www.tweag.io/blog/', listing, null)).toBe(false);
    expect(isListingArticle('https://www.tweag.io/about/', listing, null)).toBe(true);
  });

  it('always want the article page of new items, never of baseline ones', () => {
    const settings = sourceSettings('listing', { linkSelector: 'article a' });
    expect(wantsArticlePage(settings, '', false)).toBe(true);
    expect(wantsArticlePage(settings, '', true)).toBe(false);
    expect(wantsArticlePage(sourceSettings('page'), '', false)).toBe(false);
  });
});
