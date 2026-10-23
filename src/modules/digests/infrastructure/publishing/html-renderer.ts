import type { DigestPage } from '../../application/ports.ts';
import type { FailedSource, TokenUsage } from '../../domain/digest.ts';
import type { DigestEntry } from '../../domain/digest-entry.ts';
import type { Story } from '../../domain/ranking.ts';

export interface RenderOptions {
  /** Time zone for the times shown next to items. */
  readonly timezone: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Everything that came from a website or the LLM goes through here. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : '#';
}

/** Renders the digest as one self-contained HTML document (inline CSS, no JS). */
export function renderDigestPage(page: DigestPage, options: RenderOptions): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${page.runId}T00:00:00Z`));
  const time = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: options.timezone,
  });
  const all = [...page.featured, ...page.alsoNoted];
  const sources = new Set(all.flatMap((s) => s.entries.map((e) => e.sourceId))).size;
  const merged = all.filter((s) => s.entries.length > 1).length;

  const meta =
    page.itemCount === 0
      ? 'Nothing new since the last digest.'
      : `${page.itemCount} new ${plural(page.itemCount, 'item')} from ${sources} ${plural(sources, 'source')} · ${page.featured.length} highlighted` +
        (merged > 0 ? ` · ${merged} covered by several sources` : '') +
        (page.repeated.length > 0 ? ` · ${page.repeated.length} already reported` : '');

  const featured = page.featured.map((story) => {
    const lead = story.entries[0] as DigestEntry;
    const tags = [...new Set(story.entries.flatMap((e) => e.analysis?.tags ?? []))].slice(0, 5);
    const tagList = tags.length
      ? `<ul class="tags">${tags.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : '';
    return `<article>
  <p class="source">${escapeHtml(lead.sourceName)}${publishedAt(lead, time)}</p>
  <h2>${link(lead.url, headline(story))}</h2>
  <p>${escapeHtml(story.cluster.summary ?? lead.analysis?.summary ?? '')}</p>
  ${alsoCovered(story)}${followUp(story)}${tagList}
</article>`;
  });

  const alsoNoted = page.alsoNoted.length
    ? `<section class="also">
  <h2>Also noted</h2>
  <ul>${page.alsoNoted
    .map((story) => {
      const lead = story.entries[0] as DigestEntry;
      const label = story.cluster.earlier ? '<em>Follow-up</em> ' : '';
      return `<li>${label}${link(lead.url, headline(story))} <span>${story.entries.map((e) => escapeHtml(e.sourceName)).join(', ')}</span></li>`;
    })
    .join('\n  ')}</ul>
</section>`
    : '';

  const overview = page.overview
    ? `<section class="overview"><p>${escapeHtml(page.overview)}</p></section>`
    : '';

  const notes = [
    page.failedItemCount > 0
      ? `${page.failedItemCount} ${plural(page.failedItemCount, 'item')} could not be summarised and ${page.failedItemCount === 1 ? 'is' : 'are'} listed by title only.`
      : '',
    page.repeated.length > 0
      ? `Already in an earlier digest, so not repeated: ${page.repeated
          .map((story) => {
            const lead = story.entries[0] as DigestEntry;
            return `${link(lead.url, headline(story))} (${escapeHtml(lead.sourceName)})`;
          })
          .join('; ')}.`
      : '',
    page.failedSources.length > 0
      ? `Could not collect ${page.failedSources.length} ${plural(page.failedSources.length, 'source')}: ${page.failedSources.map(failedSource).join('; ')}.`
      : '',
    page.usage.inputTokens + page.usage.outputTokens > 0 ? llmUsage(page.usage) : '',
    `Generated ${escapeHtml(time.format(page.generatedAt))}.`,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Digest · ${escapeHtml(day)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">Daily digest</p>
  <h1>${escapeHtml(day)}</h1>
  <p class="meta">${meta}</p>
</header>
${overview}
${featured.join('\n')}
${alsoNoted}
<footer>${notes.map((n) => `<p>${n}</p>`).join('')}</footer>
</main>
</body>
</html>
`;
}

function headline(story: Story): string {
  return story.cluster.headline ?? story.entries[0]?.title ?? '';
}

function link(url: string, text: string): string {
  return `<a href="${safeHref(url)}" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/** The other sources of a merged story, each linking to its own article. */
function alsoCovered(story: Story): string {
  const others = story.entries.slice(1);
  if (others.length === 0) return '';
  return `<p class="covered">Also covered by ${others.map((e) => link(e.url, e.sourceName)).join(', ')}</p>
  `;
}

/** A story seen before: says so, and links where it was first reported. */
function followUp(story: Story): string {
  const earlier = story.cluster.earlier;
  if (!earlier) return '';
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${earlier.runId}T00:00:00Z`));
  return `<p class="earlier">Follow-up · first reported ${escapeHtml(day)}: ${link(earlier.url, earlier.title)} (${escapeHtml(earlier.sourceName)})</p>
  `;
}

/** "LLM: 134k tokens in, 14k out, about $0.02." */
function llmUsage(usage: TokenUsage): string {
  const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
  const cost =
    usage.costUsd === null
      ? 'cost unknown (a model has no price set)'
      : usage.costUsd < 0.01
        ? 'less than $0.01'
        : `about $${usage.costUsd.toFixed(2)}`;
  return `LLM: ${tokens(usage.inputTokens)} tokens in, ${tokens(usage.outputTokens)} out, ${cost}.`;
}

/** "Name (reason)", plus a warning when this failure made the source stop. */
function failedSource(source: FailedSource): string {
  const name = source.sourceName ? `${escapeHtml(source.sourceName)} ` : '';
  const stopped = source.disabled
    ? ' <strong>— stopped after repeated failures; enable it again once fixed</strong>'
    : '';
  return `${name}(${escapeHtml(source.reason)})${stopped}`;
}

function publishedAt(entry: DigestEntry, format: Intl.DateTimeFormat): string {
  return entry.publishedAt ? ` · ${escapeHtml(format.format(entry.publishedAt))}` : '';
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

const STYLES = `
:root { --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b6760; --line: #e6e2da; --accent: #9a3412; --chip: #f1ede6; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161513; --fg: #ece9e3; --muted: #9b968d; --line: #2c2a26; --accent: #fb923c; --chip: #24221f; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 17px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
header { margin-bottom: 2.5rem; }
.eyebrow { margin: 0; color: var(--accent); font-size: .8rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: .25rem 0 .5rem; font-size: 2rem; line-height: 1.2; }
.meta, .source, footer, .also span { color: var(--muted); }
.meta { margin: 0; }
article { padding: 1.5rem 0; border-top: 1px solid var(--line); }
article h2 { margin: .1rem 0 .5rem; font-size: 1.25rem; line-height: 1.35; }
article p { margin: 0 0 .5rem; }
.source { font-size: .85rem; margin: 0; }
a { color: inherit; text-decoration-color: var(--line); text-underline-offset: .2em; }
a:hover { color: var(--accent); text-decoration-color: currentColor; }
.tags { display: flex; flex-wrap: wrap; gap: .4rem; margin: .5rem 0 0; padding: 0; list-style: none; }
.tags li { background: var(--chip); border-radius: 999px; padding: .05rem .6rem; font-size: .8rem; color: var(--muted); }
.overview { margin: 0 0 1rem; padding: 1rem 1.25rem; background: var(--chip); border-radius: .75rem; }
.overview p { margin: 0; }
.covered, .earlier { font-size: .85rem; color: var(--muted); }
.also em { font-style: normal; font-size: .8rem; color: var(--accent); }
.also { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--line); }
.also h2 { font-size: 1rem; margin: 0 0 .75rem; }
.also ul { margin: 0; padding: 0; list-style: none; }
.also li { padding: .3rem 0; }
.also span { font-size: .85rem; margin-left: .35rem; }
footer { margin-top: 3rem; font-size: .85rem; }
footer p { margin: .25rem 0; }
`;
