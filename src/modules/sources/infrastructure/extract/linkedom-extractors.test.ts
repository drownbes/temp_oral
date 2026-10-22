import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidSourceError } from '../../domain/errors.ts';
import { LinkedomLinkExtractor } from './linkedom-link-extractor.ts';
import { LinkedomPageTextExtractor } from './linkedom-page-text-extractor.ts';

const page = (name: string) =>
  readFileSync(new URL(`../../../../../test/fixtures/pages/${name}`, import.meta.url), 'utf-8');
const BLOG = 'https://example.com/blog/';

describe('LinkedomLinkExtractor', () => {
  const extractor = new LinkedomLinkExtractor();

  it('finds links inside the selected elements, resolved, deduplicated, with the best title', () => {
    expect(extractor.extract(page('listing.html'), BLOG, 'article.post h2')).toEqual([
      {
        url: 'https://example.com/blog/2026-10-20-cosmic/',
        title: 'COSMIC & Wayland, a deep dive',
      },
      { url: 'https://example.com/blog/2026-10-18-nix/', title: 'Nix flakes in production' },
    ]);
  });

  it('without a selector returns every real link (filtering is up to the caller)', () => {
    const urls = extractor.extract(page('listing.html'), BLOG, null).map((l) => l.url);
    expect(urls).toContain('https://twitter.com/example');
    expect(urls).toContain('https://example.com/blog/tags/desktop/');
    expect(urls.some((u) => u.startsWith('mailto:') || u.endsWith('#top'))).toBe(false);
    // The image link and the headline link are the same article
    expect(urls.filter((u) => u.endsWith('2026-10-20-cosmic/'))).toHaveLength(1);
  });

  it('rejects an invalid selector as a configuration error', () => {
    expect(() => extractor.extract(page('listing.html'), BLOG, '[[')).toThrow(InvalidSourceError);
  });

  it('finds no links in a document that is not HTML', () => {
    expect(extractor.extract('26.3.0-devel\n', BLOG, null)).toEqual([]);
  });
});

describe('LinkedomPageTextExtractor', () => {
  const extractor = new LinkedomPageTextExtractor();

  it('reads just the selected part of the page', () => {
    const { title, text } = extractor.extract(
      page('releases.html'),
      'https://kernel.org/',
      '#releases',
    );
    expect(title).toBe('The Linux Kernel Archives');
    expect(text).toContain('7.4-rc2');
    expect(text).toContain('6.12.40');
    expect(text).not.toContain('FAQ');
    expect(text).not.toContain('operated by');
    // One table row per line, so a change shows which row changed
    expect(text.split('\n')).toEqual([
      'mainline: 7.4-rc2 2026-10-19',
      'stable: 7.3.5 2026-10-20',
      'longterm: 6.12.40 2026-10-20',
    ]);
  });

  it('reads the whole body without a selector, but never scripts', () => {
    const { text } = extractor.extract(page('releases.html'), 'https://kernel.org/', null);
    expect(text).toContain('FAQ');
    expect(text).toContain('operated by');
    expect(text).not.toContain('tracking');
  });

  it('watches a plain-text document as it is', () => {
    expect(extractor.extract('26.3.0-devel\n', 'https://example.org/VERSION', null)).toEqual({
      title: '',
      text: '26.3.0-devel\n',
    });
  });

  it('rejects an invalid selector as a configuration error', () => {
    expect(() => extractor.extract('<p>x</p>', 'https://kernel.org/', '##')).toThrow(
      InvalidSourceError,
    );
  });
});
