import { parseHTML } from 'linkedom';
import type { LinkExtractor, ListingLink } from '../../application/ports.ts';
import { InvalidSourceError } from '../../domain/errors.ts';
import { decodeEntities } from './html-text.ts';

/** The few DOM members used here (the project does not load the browser DOM types). */
interface DomElement {
  readonly textContent: string | null;
  readonly outerHTML: string;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): Iterable<DomElement>;
}

/**
 * Links of a listing page. With a selector, only links inside (or being) the matching
 * elements count, e.g. `article h2 a` or `.post-list`. Hrefs are resolved against the page.
 */
export class LinkedomLinkExtractor implements LinkExtractor {
  extract(html: string, pageUrl: string, linkSelector: string | null): ListingLink[] {
    const document = parseHTML(html).document as unknown as DomElement & {
      documentElement: DomElement | null;
    };
    // Not HTML (plain text, JSON): no links rather than a crash
    if (!document.documentElement) return [];
    let anchors: DomElement[];
    try {
      anchors = linkSelector
        ? [...document.querySelectorAll(linkSelector)].flatMap((el) =>
            el.matches('a[href]') ? [el] : [...el.querySelectorAll('a[href]')],
          )
        : [...document.querySelectorAll('a[href]')];
    } catch {
      throw new InvalidSourceError(`linkSelector "${linkSelector}" is not a valid CSS selector`);
    }

    // The same article is often linked twice (image + headline): keep the longest text
    const links = new Map<string, string>();
    for (const anchor of anchors) {
      const url = resolve(anchor.getAttribute('href') ?? '', pageUrl);
      if (!url) continue;
      const title = decodeEntities(anchor.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if ((links.get(url)?.length ?? -1) < title.length) links.set(url, title);
    }
    return [...links].map(([url, title]) => ({ url, title }));
  }
}

function resolve(href: string, base: string): string | undefined {
  if (!href || href.startsWith('#') || /^(mailto|javascript|tel):/i.test(href)) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}
