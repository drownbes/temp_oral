import { describe, expect, it } from 'vitest';
import type { DigestPage } from '../../application/ports.ts';
import type { DigestId } from '../../domain/digest.ts';
import type { DigestEntry } from '../../domain/digest-entry.ts';
import type { RunId } from '../../domain/run-id.ts';
import { renderDigestPage } from './html-renderer.ts';

const entry = (overrides: Partial<DigestEntry>): DigestEntry => ({
  digestId: 'd-1' as DigestId,
  itemId: 'i-1',
  sourceId: 's-1',
  sourceName: 'Phoronix',
  url: 'https://www.phoronix.com/news/a',
  title: 'Mesa 26.3 released',
  publishedAt: new Date('2026-10-21T10:05:00Z'),
  analysis: { summary: 'Mesa shipped.', relevance: 0.9, reason: 'r', tags: ['mesa', 'gpu'] },
  failure: null,
  ...overrides,
});

const page = (overrides: Partial<DigestPage> = {}): DigestPage => ({
  runId: '2026-10-22' as RunId,
  generatedAt: new Date('2026-10-22T06:01:00Z'),
  featured: [entry({})],
  alsoNoted: [entry({ itemId: 'i-2', title: 'Minor fix', analysis: null, failure: 'x' })],
  failedSources: [],
  itemCount: 2,
  analyzedCount: 1,
  failedItemCount: 1,
  ...overrides,
});

describe('renderDigestPage', () => {
  it('renders the day, featured items with summaries and tags, and headlines', () => {
    const html = renderDigestPage(page(), { timezone: 'Europe/Berlin' });

    expect(html).toContain('<h1>Thursday, 22 October 2026</h1>');
    expect(html).toContain('2 new items from 1 source · 1 highlighted');
    expect(html).toContain(
      '<a href="https://www.phoronix.com/news/a" rel="noopener noreferrer">Mesa 26.3 released</a>',
    );
    expect(html).toContain('Phoronix · 21 Oct, 12:05');
    expect(html).toContain('<p>Mesa shipped.</p>');
    expect(html).toContain('<li>gpu</li>');
    expect(html).toContain('<h2>Also noted</h2>');
    expect(html).toContain('1 item could not be summarised and is listed by title only.');
  });

  it('escapes everything that comes from websites or the model', () => {
    const html = renderDigestPage(
      page({
        featured: [
          entry({
            title: '<script>alert(1)</script>',
            url: 'javascript:alert(1)',
            sourceName: 'A & B',
            analysis: {
              summary: '"><img src=x onerror=alert(1)>',
              relevance: 1,
              reason: '',
              tags: ['<b>'],
            },
          }),
        ],
        failedSources: [{ sourceId: 's', reason: '<i>HTTP 500</i>' }],
      }),
      { timezone: 'UTC' },
    );

    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>HTTP');
    expect(html).toContain('href="#"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; B');
  });

  it('says so when nothing is new', () => {
    const html = renderDigestPage(
      page({ featured: [], alsoNoted: [], itemCount: 0, analyzedCount: 0, failedItemCount: 0 }),
      { timezone: 'UTC' },
    );
    expect(html).toContain('Nothing new since the last digest.');
    expect(html).not.toContain('Also noted');
  });
});
