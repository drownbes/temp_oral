import { type AnyFeed, parseFeed } from 'feedsmith';
import type { FeedEntry, FeedReader } from '../../application/ports.ts';
import { InvalidFeedError } from '../../domain/errors.ts';
import { decodeEntities, htmlToText } from './html-text.ts';

interface RawEntry {
  readonly link: string | undefined;
  readonly title: string | undefined;
  readonly date: string | undefined;
  readonly html: string | undefined;
}

/** RSS 0.9x/2.0, Atom 0.3/1.0, RDF and JSON Feed through feedsmith's universal parser. */
export class FeedsmithFeedReader implements FeedReader {
  read(body: string, baseUrl: string): FeedEntry[] {
    let entries: RawEntry[];
    try {
      entries = rawEntries(parseFeed(body));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new InvalidFeedError(`${baseUrl} is not a readable feed: ${reason}`, { cause: err });
    }

    return entries.flatMap((entry) => {
      const url = resolve(entry.link, baseUrl);
      if (!url) return [];
      const html = entry.html ?? '';
      return [
        {
          url,
          title: decodeEntities(entry.title ?? '').trim(),
          publishedAt: parseDate(entry.date),
          html,
          text: htmlToText(html),
        },
      ];
    });
  }
}

function rawEntries(parsed: AnyFeed<string>): RawEntry[] {
  switch (parsed.format) {
    case 'rss':
      return (parsed.feed.items ?? []).map((item) => ({
        link: item.link ?? (item.guid?.isPermaLink !== false ? item.guid?.value : undefined),
        title: item.title,
        date: item.pubDate ?? item.dc?.dates?.[0],
        html: item.content?.encoded ?? item.description,
      }));
    case 'atom':
      return (parsed.feed.entries ?? []).map((entry) => {
        const links = entry.links ?? [];
        const link = links.find((l) => !l.rel || l.rel === 'alternate') ?? links[0];
        return {
          link: link?.href,
          title: entry.title?.value,
          date: entry.published ?? entry.updated,
          html: entry.content?.value ?? entry.summary?.value,
        };
      });
    case 'rdf':
      return (parsed.feed.items ?? []).map((item) => ({
        link: item.link,
        title: item.title,
        date: item.dc?.dates?.[0],
        html: item.content?.encoded ?? item.description,
      }));
    case 'json':
      return (parsed.feed.items ?? []).map((item) => ({
        link: item.url ?? item.external_url,
        title: item.title,
        date: item.date_published ?? item.date_modified,
        html: item.content_html ?? escapeText(item.content_text ?? item.summary),
      }));
  }
}

function resolve(link: string | undefined, baseUrl: string): string | undefined {
  if (!link) return undefined;
  try {
    return new URL(link.trim(), baseUrl).href;
  } catch {
    return undefined;
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeText(text: string | undefined): string | undefined {
  return text?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
