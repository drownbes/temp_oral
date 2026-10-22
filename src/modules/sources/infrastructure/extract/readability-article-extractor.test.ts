import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReadabilityArticleExtractor } from './readability-article-extractor.ts';

const page = (name: string) =>
  readFileSync(new URL(`../../../../../test/fixtures/pages/${name}`, import.meta.url), 'utf-8');

describe('ReadabilityArticleExtractor', () => {
  const extractor = new ReadabilityArticleExtractor();

  it('extracts the article body without navigation, sidebar, scripts or footer', () => {
    const article = extractor.extract(page('article.html'), 'https://example.com/cosmic-1-11');

    expect(article?.title).toContain('COSMIC 1.11');
    expect(article?.text).toContain('System76 released COSMIC 1.11 today');
    expect(article?.text).toContain('The release adds new options in COSMIC Settings');
    expect(article?.text).toContain('should arrive in the repositories');
    for (const noise of ['Popular', 'Some other story', 'window.ads', 'All rights reserved']) {
      expect(article?.text).not.toContain(noise);
    }
    // Paragraphs stay separate lines
    expect(article?.text.split('\n').length).toBeGreaterThanOrEqual(4);
  });

  it('finds no article on pages without one', () => {
    const index = '<html><body><nav><a href="/1">One</a> <a href="/2">Two</a></nav></body></html>';
    expect(extractor.extract(index, 'https://example.com/')).toBeUndefined();
    expect(extractor.extract('', 'https://example.com/')).toBeUndefined();
  });
});
