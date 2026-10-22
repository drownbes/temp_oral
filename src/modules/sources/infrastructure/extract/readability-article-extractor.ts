import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { ArticleExtractor, ExtractedArticle } from '../../application/ports.ts';
import { htmlToText } from './html-text.ts';

/** Less than this after extraction is a cookie wall, an index page or an error page. */
const MIN_ARTICLE_CHARS = 200;

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
    if (text.length < MIN_ARTICLE_CHARS) return undefined;
    return { title: article.title?.trim() ?? '', html: article.content, text };
  }
}
