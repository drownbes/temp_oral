import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ArticleExtractor, ExtractedArticle } from '../../application/ports.ts';
import { htmlToText } from './html-text.ts';

/** Less than this after extraction is a cookie wall, an index page or an error page. */
const MIN_ARTICLE_CHARS = 200;
/** Consent notices are short; an article that merely discusses cookies is longer. */
const MAX_CONSENT_NOTICE_CHARS = 1500;
/** Wording of cookie / consent notices; a notice uses several of these at once. */
const CONSENT_TERMS = [
  /\bconsent\b/i,
  /\baccept( all)?\b/i,
  /\breject( all)?\b/i,
  /\bprivacy (policy|settings|statement)\b/i,
  /\bcookie (policy|settings|preferences)\b/i,
  /\bpersonali[sz](ed|e)\b/i,
  /\b(analy[sz]e|measure) (site )?traffic\b/i,
  /\bmanage (cookies|preferences|settings|choices)\b/i,
];
const MIN_CONSENT_TERMS = 3;

/**
 * A cookie or consent notice that Readability took for the article: it wins on pages whose
 * real content is short or not written in paragraphs.
 */
export function isConsentNotice(text: string): boolean {
  if (text.length > MAX_CONSENT_NOTICE_CHARS || !/\bcookies?\b/i.test(text)) return false;
  return CONSENT_TERMS.filter((term) => term.test(text)).length >= MIN_CONSENT_TERMS;
}

/** Mozilla's Readability (Firefox reader view) on linkedom, a light server-side DOM. */
export class ReadabilityArticleExtractor implements ArticleExtractor {
  extract(html: string, _url: string): ExtractedArticle | undefined {
    const { document } = parseHTML(html);
    if (!document?.documentElement) return undefined;
    let article: ReturnType<Readability['parse']>;
    try {
      // Readability is typed against the browser DOM; linkedom implements what it uses
      article = new Readability(
        document as unknown as ConstructorParameters<typeof Readability>[0],
      ).parse();
    } catch {
      // Malformed markup: treat as a page without an article, never fail the collection
      return undefined;
    }
    if (!article?.content) return undefined;
    const text = htmlToText(article.content);
    if (text.length < MIN_ARTICLE_CHARS || isConsentNotice(text)) return undefined;
    return { title: article.title?.trim() ?? '', html: article.content, text };
  }
}
