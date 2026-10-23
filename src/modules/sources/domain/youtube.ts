/** YouTube channels as sources: read through their public feed, one item per video. */

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function isYouTubeUrl(url: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && YOUTUBE_HOSTS.has(parsed.hostname);
}

/**
 * The channel id (UC…) a URL names by itself: youtube.com/channel/UC… or the channel's feed.
 * Handles (youtube.com/@name) and custom URLs need the channel page to find it.
 */
export function youtubeChannelIdOf(url: string): string | undefined {
  const parsed = parse(url);
  if (!parsed || !YOUTUBE_HOSTS.has(parsed.hostname)) return undefined;
  const id =
    parsed.pathname === '/feeds/videos.xml'
      ? parsed.searchParams.get('channel_id')
      : /^\/channel\/([^/]+)/.exec(parsed.pathname)?.[1];
  return id && CHANNEL_ID.test(id) ? id : undefined;
}

export const youtubeChannelUrl = (channelId: string): string =>
  `https://www.youtube.com/channel/${channelId}`;

/** The channel's public Atom feed of its latest uploads (15 of them, Shorts included). */
export const youtubeFeedUrl = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

/** The video id of a watch, Shorts or youtu.be link. */
export function youtubeVideoId(url: string): string | undefined {
  const parsed = parse(url);
  if (!parsed) return undefined;
  const id =
    parsed.hostname === 'youtu.be'
      ? parsed.pathname.slice(1)
      : YOUTUBE_HOSTS.has(parsed.hostname)
        ? parsed.pathname === '/watch'
          ? parsed.searchParams.get('v')
          : /^\/shorts\/([^/]+)/.exec(parsed.pathname)?.[1]
        : undefined;
  return id && VIDEO_ID.test(id) ? id : undefined;
}

/** Shorts rarely say enough for a digest; the feed links them as youtube.com/shorts/…. */
export function isYouTubeShort(url: string): boolean {
  const parsed = parse(url);
  return (
    parsed !== undefined &&
    YOUTUBE_HOSTS.has(parsed.hostname) &&
    parsed.pathname.startsWith('/shorts/')
  );
}

/**
 * A video's text: what is said in it, then its description (often mostly links and
 * sponsors, so it comes last and is the first to be cut). The description alone when the
 * video has no transcript.
 */
export function videoText(description: string, transcript: string | undefined): string {
  const said = transcript?.trim();
  if (!said) return description;
  const described = description.trim();
  return described ? `${said}\n\nVideo description:\n${described}` : said;
}
