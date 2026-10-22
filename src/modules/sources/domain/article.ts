import type { SourceSettings } from './source.ts';

/** Feed text shorter than this is a teaser; the article page has the real text. */
export const TEASER_MAX_CHARS = 1500;

/**
 * Whether to fetch an entry's own page: only for feeds that allow it, only when the feed
 * gave a teaser, and never for baseline items (they are never handed to a digest).
 */
export function wantsArticlePage(
  settings: SourceSettings,
  feedText: string,
  baseline: boolean,
): boolean {
  return (
    settings.kind === 'feed' &&
    settings.fetchArticles &&
    !baseline &&
    feedText.length < TEASER_MAX_CHARS
  );
}

/** The article's own text replaces the feed's only when it actually says more. */
export function prefersArticleText(feedText: string, articleText: string): boolean {
  return articleText.trim().length > feedText.trim().length;
}
