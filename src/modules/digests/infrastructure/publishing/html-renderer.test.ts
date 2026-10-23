import { describe, expect, it } from 'vitest';
import type { DigestPage } from '../../application/ports.ts';
import type { DigestId } from '../../domain/digest.ts';
import type { DigestEntry } from '../../domain/digest-entry.ts';
import type { Story } from '../../domain/ranking.ts';
import type { RunId } from '../../domain/run-id.ts';
import type { EarlierCoverage } from '../../domain/story.ts';
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
  embedding: null,
  ...overrides,
});

const story = (
  entries: DigestEntry[],
  text: { headline: string; summary: string } | null = null,
  earlier: EarlierCoverage | null = null,
): Story => ({
  cluster: {
    id: entries[0]?.itemId ?? '',
    itemIds: entries.map((e) => e.itemId),
    headline: text?.headline ?? null,
    summary: text?.summary ?? null,
    earlier,
  },
  entries,
  relevance: Math.max(...entries.map((e) => e.analysis?.relevance ?? -1)),
});

const page = (overrides: Partial<DigestPage> = {}): DigestPage => ({
  runId: '2026-10-22' as RunId,
  generatedAt: new Date('2026-10-22T06:01:00Z'),
  overview: null,
  featured: [story([entry({})])],
  alsoNoted: [story([entry({ itemId: 'i-2', title: 'Minor fix', analysis: null, failure: 'x' })])],
  repeated: [],
  failedSources: [],
  itemCount: 2,
  analyzedCount: 1,
  failedItemCount: 1,
  usage: { inputTokens: 134_260, outputTokens: 14_152, costUsd: 0.0205 },
  ...overrides,
});

describe('renderDigestPage', () => {
  it('renders the day, featured stories with summaries and tags, and headlines', () => {
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
    expect(html).not.toContain('class="overview"');
  });

  it('shows a merged story once, with its synthesised text and the other sources linked', () => {
    const merged = story(
      [
        entry({}),
        entry({
          itemId: 'i-9',
          sourceId: 's-2',
          sourceName: '9to5Linux',
          url: 'https://9to5linux.com/mesa',
          analysis: { summary: 's', relevance: 0.5, reason: '', tags: ['graphics'] },
        }),
      ],
      { headline: 'Mesa 26.3 brings faster Vulkan', summary: 'Both sources report the release.' },
    );
    const html = renderDigestPage(
      page({ featured: [merged], overview: 'A big day for graphics.' }),
      { timezone: 'UTC' },
    );

    expect(html).toContain('<section class="overview"><p>A big day for graphics.</p></section>');
    expect(html).toContain('>Mesa 26.3 brings faster Vulkan</a>');
    expect(html).toContain('<p>Both sources report the release.</p>');
    expect(html).toContain(
      'Also covered by <a href="https://9to5linux.com/mesa" rel="noopener noreferrer">9to5Linux</a>',
    );
    expect(html).toContain('<li>graphics</li>');
    expect(html).toContain('from 2 sources · 1 highlighted · 1 covered by several sources');
  });

  it('escapes everything that comes from websites or the model', () => {
    const html = renderDigestPage(
      page({
        overview: '<script>overview()</script>',
        featured: [
          story([
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
          ]),
        ],
        failedSources: [{ sourceId: 's', sourceName: '<b>Feed</b>', reason: '<i>HTTP 500</i>' }],
      }),
      { timezone: 'UTC' },
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>HTTP');
    expect(html).toContain('href="#"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; B');
  });

  it('labels follow-ups with the earlier report and lists repeats only in the footer', () => {
    const earlier = (kind: EarlierCoverage['kind']): EarlierCoverage => ({
      kind,
      runId: '2026-10-21',
      sourceName: '9to5Linux',
      title: 'DietPi 10.8 <released>',
      url: 'https://9to5linux.com/dietpi-10-8',
      similarity: kind === 'repeat' ? 1 : 0.9,
    });
    const html = renderDigestPage(
      page({
        featured: [story([entry({})], null, earlier('follow-up'))],
        alsoNoted: [],
        repeated: [
          story(
            [entry({ itemId: 'i-3', sourceName: 'LXer', title: 'DietPi 10.8 again' })],
            null,
            earlier('repeat'),
          ),
        ],
        itemCount: 2,
      }),
      { timezone: 'UTC' },
    );

    expect(html).toContain(
      '<p class="earlier">Follow-up · first reported 21 Oct: <a href="https://9to5linux.com/dietpi-10-8" rel="noopener noreferrer">DietPi 10.8 &lt;released&gt;</a> (9to5Linux)</p>',
    );
    expect(html).toContain('· 1 already reported');
    expect(html).toContain('Already in an earlier digest, so not repeated: ');
    expect(html).toContain('DietPi 10.8 again</a> (LXer)');
    // Not among the stories
    expect(html.split('<article>')).toHaveLength(2);
  });

  it('shows what the LLM calls cost, or that the cost is unknown', () => {
    expect(renderDigestPage(page(), { timezone: 'UTC' })).toContain(
      '<p>LLM: 134k tokens in, 14k out, about $0.02.</p>',
    );
    const cheap = { inputTokens: 900, outputTokens: 40, costUsd: 0.0001 };
    expect(renderDigestPage(page({ usage: cheap }), { timezone: 'UTC' })).toContain(
      'LLM: 900 tokens in, 40 out, less than $0.01.',
    );
    const unknown = { ...cheap, costUsd: null };
    expect(renderDigestPage(page({ usage: unknown }), { timezone: 'UTC' })).toContain(
      'cost unknown (a model has no price set)',
    );
    const none = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    expect(renderDigestPage(page({ usage: none }), { timezone: 'UTC' })).not.toContain('LLM:');
  });

  it('names failed sources and flags the ones that were stopped', () => {
    const html = renderDigestPage(
      page({
        failedSources: [
          { sourceId: 's-1', sourceName: 'Fedora Magazine', reason: 'HTTP 503' },
          { sourceId: 's-2', sourceName: 'Old blog', reason: 'HTTP 410', disabled: true },
          { sourceId: 's-3', reason: 'timeout' },
        ],
      }),
      { timezone: 'UTC' },
    );
    expect(html).toContain(
      'Could not collect 3 sources: Fedora Magazine (HTTP 503); Old blog (HTTP 410) <strong>— stopped after repeated failures; enable it again once fixed</strong>; (timeout).',
    );
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
