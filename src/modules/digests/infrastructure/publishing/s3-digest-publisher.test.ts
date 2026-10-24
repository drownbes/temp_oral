import { describe, expect, it } from 'vitest';
import { relativeHref } from './s3-digest-publisher.ts';

describe('relativeHref', () => {
  it('links pages by key, relative to the page that holds the link', () => {
    expect(relativeHref('digests/latest/index.html', 'digests/archive/index.html')).toBe(
      '../archive/index.html',
    );
    expect(relativeHref('digests/archive/index.html', 'digests/archive/2026-10-22.html')).toBe(
      '2026-10-22.html',
    );
    expect(relativeHref('index.html', 'archive/index.html')).toBe('archive/index.html');
  });
});
