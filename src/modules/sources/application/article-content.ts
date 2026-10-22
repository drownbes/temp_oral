import type { ArticleExtractor, PageFetcher } from './ports.ts';

export type ArticleFetch =
  | {
      readonly ok: true;
      /** The whole page, kept as the item's raw content. */
      readonly pageHtml: string;
      readonly title: string;
      readonly text: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Fetches an article page and extracts its readable text. Never throws: an article that
 * cannot be fetched or read just leaves the item with its feed text.
 */
export async function fetchArticle(
  deps: { fetcher: PageFetcher; extractor: ArticleExtractor },
  url: string,
): Promise<ArticleFetch> {
  try {
    const page = await deps.fetcher.fetch({ url, validators: { etag: null, lastModified: null } });
    if (page.status !== 'ok') return { ok: false, reason: 'unexpected not-modified' };
    const article = deps.extractor.extract(page.body, page.url);
    if (!article) return { ok: false, reason: 'no readable article on the page' };
    return { ok: true, pageHtml: page.body, title: article.title, text: article.text };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
