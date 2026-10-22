import type { SourceSettings } from './source.ts';

/** Feed text shorter than this is a teaser; the article page has the real text. */
export const TEASER_MAX_CHARS = 1500;

/**
 * Whether to fetch an entry's own page. Never for baseline items (they are never handed to
 * a digest). Feeds: only when allowed and the feed gave a teaser. Listings: always, the
 * index page only has links.
 */
export function wantsArticlePage(
  settings: SourceSettings,
  feedText: string,
  baseline: boolean,
): boolean {
  if (baseline) return false;
  switch (settings.kind) {
    case 'feed':
      return settings.fetchArticles && feedText.length < TEASER_MAX_CHARS;
    case 'listing':
      return true;
    case 'page':
      return false;
  }
}

/** The article's own text replaces the feed's only when it actually says more. */
export function prefersArticleText(feedText: string, articleText: string): boolean {
  return articleText.trim().length > feedText.trim().length;
}

/**
 * Which links of a listing page are articles: same site as the listing (other sites are
 * ads, social buttons, partners), not the listing itself, and matching `urlPattern` if set.
 */
export function isListingArticle(
  url: string,
  listingUrl: string,
  urlPattern: string | null,
): boolean {
  let link: URL;
  let listing: URL;
  try {
    link = new URL(url);
    listing = new URL(listingUrl);
  } catch {
    return false;
  }
  if (link.hostname.replace(/^www\./, '') !== listing.hostname.replace(/^www\./, '')) return false;
  if (link.pathname === listing.pathname && link.search === listing.search) return false;
  return urlPattern ? new RegExp(urlPattern).test(link.href) : true;
}
