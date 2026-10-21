/** Query parameters that only track the click and never change the content. */
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi)$/i;

/**
 * Normalises an http(s) URL so the same page always maps to the same string: resolves it
 * against `base`, drops the fragment and tracking parameters, and sorts the query.
 * Returns undefined for anything that is not an absolute http(s) URL.
 */
export function canonicalizeUrl(raw: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  url.hash = '';
  url.username = '';
  url.password = '';
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  return url.href;
}
