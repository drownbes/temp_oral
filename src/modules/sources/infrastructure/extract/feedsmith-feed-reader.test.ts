import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidFeedError } from '../../domain/errors.ts';
import { FeedsmithFeedReader } from './feedsmith-feed-reader.ts';
import { htmlToText } from './html-text.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../../test/fixtures/feeds/${name}`, import.meta.url), 'utf-8');

describe('FeedsmithFeedReader', () => {
  const reader = new FeedsmithFeedReader();

  it('reads RSS 2.0 with full content, guid permalinks and dc:date', () => {
    const entries = reader.read(fixture('rss2.xml'), 'https://blog.example.com/feed.xml');

    expect(entries).toEqual([
      {
        url: 'https://blog.example.com/posts/hello?utm_source=rss',
        title: 'Hello & welcome',
        publishedAt: new Date('2026-10-20T10:00:00Z'),
        html: expect.stringContaining('<p>Full <b>content</b> here.</p>'),
        text: 'Full content here.\nSecond paragraph – done.',
      },
      {
        url: 'https://blog.example.com/posts/guid-link',
        title: 'Only a guid',
        publishedAt: new Date('2026-10-19T08:30:00Z'),
        html: '<p>Escaped <em>HTML</em></p>',
        text: 'Escaped HTML',
      },
    ]);
  });

  it('reads Atom, resolving relative links and preferring the alternate link', () => {
    const entries = reader.read(fixture('atom.xml'), 'https://news.example.org/feed.atom');

    expect(entries).toEqual([
      {
        url: 'https://news.example.org/articles/1',
        title: 'Relative link entry',
        publishedAt: new Date('2026-10-19T10:00:00Z'),
        html: 'Summary only',
        text: 'Summary only',
      },
      {
        url: 'https://news.example.org/articles/2',
        title: 'Content entry',
        publishedAt: null,
        html: '<h1>Heading</h1><p>Body</p>',
        text: 'Heading\nBody',
      },
    ]);
  });

  it('reads JSON Feed plain-text content', () => {
    const [entry] = reader.read(fixture('feed.json'), 'https://json.example.net/feed.json');
    expect(entry).toMatchObject({
      url: 'https://json.example.net/1',
      text: 'Line one\nLine <two>',
      publishedAt: new Date('2026-10-18T09:00:00Z'),
    });
  });

  it('rejects documents that are not feeds', () => {
    expect(() => reader.read('<html><body>hi</body></html>', 'https://example.com/')).toThrow(
      InvalidFeedError,
    );
  });
});

describe('htmlToText', () => {
  it('drops scripts, styles and comments, keeps block structure', () => {
    expect(
      htmlToText(
        '<style>p{}</style><!-- x --><h2>Title</h2><p>a&amp;b &#x263A;</p><ul><li>one</li><li>two</li></ul>',
      ),
    ).toBe('Title\na&b ☺\none\ntwo');
  });
});
