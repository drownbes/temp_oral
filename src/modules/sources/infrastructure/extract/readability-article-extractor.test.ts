import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isConsentNotice, ReadabilityArticleExtractor } from './readability-article-extractor.ts';

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

  it('does not take a cookie consent notice for the article', () => {
    // Steam's notice, which won over a short post written without paragraphs
    const notice =
      'Do you mind if we use optional cookies to provide you personalized content and to ' +
      "analyze site traffic? We don't use a lot of cookies; you can see and manage them at any " +
      "time on our Cookie Settings page. If you click 'Accept All,' you consent to the use of " +
      'cookies on Steam websites. Learn more about cookies in our Privacy Policy.';
    const html = `<html><head><title>Client update</title></head><body>
      <div class="post"><div>We have just shipped an update.</div><ul><li>HDR fixes</li></ul></div>
      <div class="banner"><p>${notice}</p><button>Accept All</button></div></body></html>`;

    expect(isConsentNotice(notice)).toBe(true);
    expect(extractor.extract(html, 'https://example.com/news/1')).toBeUndefined();
  });

  it('still reads articles that are about cookies', () => {
    const story =
      'Firefox 150 blocks third-party cookies by default in all windows, extending the Total ' +
      'Cookie Protection that private browsing already had. Sites that relied on them for ' +
      'single sign-on get a temporary exemption, and the release notes list the affected ' +
      'APIs, the new about:config switches and the telemetry Mozilla will collect.';
    const html = `<html><head><title>Firefox 150</title></head><body><article>
      <h1>Firefox 150 blocks third-party cookies</h1><p>${story}</p></article></body></html>`;

    expect(isConsentNotice(story)).toBe(false);
    expect(extractor.extract(html, 'https://example.com/firefox-150')?.text).toContain(
      'Total Cookie Protection',
    );
  });

  it('finds no article on pages without one', () => {
    const index = '<html><body><nav><a href="/1">One</a> <a href="/2">Two</a></nav></body></html>';
    expect(extractor.extract(index, 'https://example.com/')).toBeUndefined();
    expect(extractor.extract('', 'https://example.com/')).toBeUndefined();
  });
});
