import { fetch, type RequestInit, type Response } from 'undici';
import type { VideoTranscripts, YouTubeChannels } from '../../application/ports.ts';
import { SourceFetchError } from '../../domain/errors.ts';
import { decodeEntities } from '../extract/html-text.ts';
import { readBody } from '../fetch/read-body.ts';

export interface YouTubeClientOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly userAgent: string;
  /** Tests only: where youtube.com is served instead. */
  readonly baseUrl?: string;
}

export interface CaptionTrack {
  readonly baseUrl: string;
  readonly languageCode: string;
  /** 'asr' for captions YouTube generated from the speech. */
  readonly kind?: string;
}

interface PlayerResponse {
  readonly playabilityStatus?: { readonly status?: string; readonly reason?: string };
  readonly captions?: {
    readonly playerCaptionsTracklistRenderer?: { readonly captionTracks?: CaptionTrack[] };
  };
}

/**
 * The Android app's client: its player responses carry caption URLs that work without the
 * proof-of-origin token the web player's need. YouTube retires old app versions; when
 * transcripts stop coming ("not playable" errors), raise this to a current one.
 */
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  androidSdkVersion: 30,
  hl: 'en',
} as const;
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT.clientVersion} (Linux; U; Android 11) gzip`;
/** Declines the cookie consent wall EU visitors get instead of the page. */
const CONSENT_COOKIE = 'SOCS=CAI';
/** Where a channel page names its own id, most reliable first. */
const CHANNEL_ID_IN_PAGE = [
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
  /feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/,
  /"externalId":"(UC[\w-]{22})"/,
];

/**
 * What YouTube has beyond its public channel feeds: the channel behind a handle (read from
 * the channel page) and video transcripts (through the player API the apps use; not a
 * documented API, so expect to adjust it when YouTube changes).
 */
export class YouTubeClient implements YouTubeChannels, VideoTranscripts {
  readonly #options: YouTubeClientOptions;
  readonly #base: URL;

  constructor(options: YouTubeClientOptions) {
    this.#options = options;
    this.#base = new URL(options.baseUrl ?? 'https://www.youtube.com');
  }

  async channelIdOf(url: string): Promise<string> {
    const { pathname, search } = new URL(url);
    const page = new URL(pathname + search, this.#base);
    const response = await this.#request(page, {
      headers: { 'user-agent': this.#options.userAgent, 'accept-language': 'en' },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new SourceFetchError(`no YouTube channel at ${url}`);
    }
    const html = await this.#text(response, page);
    for (const pattern of CHANNEL_ID_IN_PAGE) {
      const id = pattern.exec(html)?.[1];
      if (id) return id;
    }
    throw new SourceFetchError(`${url} is not a YouTube channel page`);
  }

  async transcriptOf(videoId: string): Promise<string | undefined> {
    const api = new URL('/youtubei/v1/player?prettyPrint=false', this.#base);
    const response = await this.#request(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': ANDROID_USER_AGENT },
      body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
    });
    const player = JSON.parse(await this.#text(response, api)) as PlayerResponse;
    const { status, reason } = player.playabilityStatus ?? {};
    if (status !== 'OK') {
      throw new Error(`YouTube does not play ${videoId}: ${reason ?? status ?? 'no status'}`);
    }

    const track = pickCaptionTrack(
      player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [],
    );
    if (!track) return undefined;
    const captions = new URL(track.baseUrl, this.#base);
    if (captions.origin !== this.#base.origin) {
      throw new Error(`unexpected captions host ${captions.host}`);
    }
    // Without a format the captions come as plain <text> elements
    captions.searchParams.delete('fmt');
    const xml = await this.#text(
      await this.#request(captions, { headers: { 'user-agent': ANDROID_USER_AGENT } }),
      captions,
    );
    const text = captionText(xml);
    // What YouTube sends when it wants a token after all
    if (!text) throw new Error(`the captions of ${videoId} came back empty`);
    return text;
  }

  async #request(url: URL, init: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), cookie: CONSENT_COOKIE },
      signal: AbortSignal.timeout(this.#options.timeoutMs),
    });
  }

  /** The body as text; 429 and 5xx are worth retrying, other failures are not. */
  async #text(response: Response, url: URL): Promise<string> {
    const { status } = response;
    if (status < 200 || status >= 300) {
      await response.body?.cancel();
      const message = `HTTP ${status} from ${url.origin}${url.pathname}`;
      throw status === 429 || status >= 500 ? new Error(message) : new SourceFetchError(message);
    }
    return new TextDecoder().decode(await readBody(response, url, this.#options.maxBytes));
  }
}

/**
 * The captions the channel wrote in the language spoken in the video, otherwise the
 * generated ones (always in that language), otherwise any it wrote.
 */
export function pickCaptionTrack(tracks: readonly CaptionTrack[]): CaptionTrack | undefined {
  const language = (track: CaptionTrack) => track.languageCode.split('-')[0];
  const generated = tracks.find((t) => t.kind === 'asr');
  const written = tracks.filter((t) => t.kind !== 'asr');
  return (
    (generated && written.find((t) => language(t) === language(generated))) ??
    generated ??
    written[0]
  );
}

/** The spoken text of timed-text captions, as one paragraph. */
export function captionText(xml: string): string {
  const lines = [...xml.matchAll(/<(text|p)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) =>
    // Caption text is escaped twice ("&amp;#39;" for an apostrophe)
    decodeEntities(decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, ''))),
  );
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}
