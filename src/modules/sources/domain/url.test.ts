import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from './url.ts';

describe('canonicalizeUrl', () => {
  it.each([
    ['https://Example.COM:443/a?b=2&a=1#frag', 'https://example.com/a?a=1&b=2'],
    ['https://example.com/a?utm_source=x&id=7&fbclid=y', 'https://example.com/a?id=7'],
    ['https://user:pw@example.com/', 'https://example.com/'],
    ['http://example.com', 'http://example.com/'],
  ])('%s -> %s', (raw, expected) => {
    expect(canonicalizeUrl(raw)).toBe(expected);
  });

  it('resolves relative URLs against a base', () => {
    expect(canonicalizeUrl('/posts/1', 'https://example.com/blog/feed')).toBe(
      'https://example.com/posts/1',
    );
  });

  it.each(['mailto:a@example.com', 'javascript:alert(1)', 'not a url', '/relative'])(
    'rejects %s',
    (raw) => {
      expect(canonicalizeUrl(raw)).toBeUndefined();
    },
  );
});
