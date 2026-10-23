import type { SourceSettings } from './source.ts';

/** Feed text shorter than this is a teaser; the article page has the real text. */
export const TEASER_MAX_CHARS = 1500;

/**
 * Whether to fetch an entry's own page. Never for baseline items (they are never handed to
 * a digest). Feeds: only when allowed and the feed gave a teaser. Listings: always, the
 * index page only has links. Videos get their transcript instead.
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
    case 'youtube':
      return false;
  }
}

/** The article's own text replaces the feed's only when it actually says more. */
export function prefersArticleText(feedText: string, articleText: string): boolean {
  return articleText.trim().length > feedText.trim().length;
}

/** Link text longer than this is a whole card (teaser, date, labels), not a headline. */
export const MAX_LINK_TITLE_CHARS = 200;
/** How page titles join the headline with the site's name ("Post - Blog", "Post | Site"). */
const TITLE_SEPARATOR = /\s+[-|–—·]\s+/;

/**
 * Title of a listing item. Links are often whole cards ("teaser… Headline · Patch notes ·
 * 2 hours ago"); when the card contains the article's title, or a part of it without the
 * site name, that part is the headline. Otherwise the link text, unless it is empty or too
 * long to be a headline.
 */
export function listingItemTitle(linkText: string, articleTitle: string): string {
  const link = linkText.replace(/\s+/g, ' ').trim();
  const article = articleTitle.replace(/\s+/g, ' ').trim();
  if (!article) return link;
  if (!link) return article;

  const lowerLink = link.toLowerCase();
  const headline = [article, ...article.split(TITLE_SEPARATOR)]
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && lowerLink.includes(part.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (headline) return headline;
  return link.length > MAX_LINK_TITLE_CHARS ? article : link;
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
