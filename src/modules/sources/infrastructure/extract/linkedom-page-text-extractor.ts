import { parseHTML } from 'linkedom';
import type { PageText, PageTextExtractor } from '../../application/ports.ts';
import { InvalidSourceError } from '../../domain/errors.ts';
import { decodeEntities, htmlToText } from './html-text.ts';

/** The few DOM members used here (the project does not load the browser DOM types). */
interface DomElement {
  readonly innerHTML: string;
  readonly textContent: string | null;
  readonly outerHTML: string;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): Iterable<DomElement>;
}

/**
 * Text of a watched page: the elements matching `contentSelector`, or the whole body.
 * Plain-text documents are taken as they are.
 */
export class LinkedomPageTextExtractor implements PageTextExtractor {
  extract(html: string, _url: string, contentSelector: string | null): PageText {
    const { document } = parseHTML(html) as unknown as {
      document: DomElement & {
        title: string;
        body: DomElement | null;
        documentElement: DomElement | null;
      };
    };
    // Not HTML at all (a plain-text file such as a VERSION or changelog): watch it as is
    if (!document.documentElement) return { title: '', text: html };
    const title = decodeEntities(document.title ?? '').trim();
    let parts: string[];
    try {
      parts = contentSelector
        ? [...document.querySelectorAll(contentSelector)].map((el) => el.outerHTML)
        : [document.body?.innerHTML ?? html];
    } catch {
      throw new InvalidSourceError(
        `contentSelector "${contentSelector}" is not a valid CSS selector`,
      );
    }
    return { title, text: parts.map(htmlToText).filter(Boolean).join('\n') };
  }
}
