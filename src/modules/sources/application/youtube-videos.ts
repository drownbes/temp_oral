import { InvalidSourceError } from '../domain/errors.ts';
import type { SourceKind } from '../domain/source.ts';
import { canonicalizeUrl } from '../domain/url.ts';
import {
  isYouTubeUrl,
  youtubeChannelIdOf,
  youtubeChannelUrl,
  youtubeVideoId,
} from '../domain/youtube.ts';
import type { VideoTranscripts, YouTubeChannels } from './ports.ts';

/**
 * The URL a source is saved under. YouTube sources are saved as their channel URL, so a
 * handle (youtube.com/@name) is looked up once here; the collector then needs no lookup.
 */
export async function sourceUrlFor(
  channels: YouTubeChannels,
  kind: SourceKind,
  url: string,
): Promise<string> {
  if (kind !== 'youtube') return url;
  const canonical = canonicalizeUrl(url);
  if (!canonical || !isYouTubeUrl(canonical)) {
    throw new InvalidSourceError('youtube sources need a youtube.com channel URL');
  }
  if (youtubeChannelIdOf(canonical)) return canonical;
  return youtubeChannelUrl(await channels.channelIdOf(canonical));
}

export type TranscriptFetch =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * A video's transcript. Never throws: a video without captions, or whose captions cannot
 * be read, keeps its description as its text.
 */
export async function fetchTranscript(
  transcripts: VideoTranscripts,
  videoUrl: string,
): Promise<TranscriptFetch> {
  const videoId = youtubeVideoId(videoUrl);
  if (!videoId) return { ok: false, reason: 'not a YouTube video link' };
  try {
    const text = await transcripts.transcriptOf(videoId);
    return text?.trim() ? { ok: true, text } : { ok: false, reason: 'the video has no captions' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
