import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceFetchError } from '../../domain/errors.ts';
import { captionText, pickCaptionTrack, YouTubeClient } from './youtube-client.ts';

const CHANNEL_ID = 'UCHnyfMqiRRG1u-2MsSQLbXA';
const CAPTIONS =
  '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
  '<text start="0" dur="2.8">- In 1887, a young\nteacher</text>' +
  '<text start="2.8" dur="3">it&amp;#39;s &amp;quot;true&amp;quot;</text></transcript>';

/** Stands in for youtube.com: channel pages, the player API and caption files. */
function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const base = `http://${req.headers.host}`;
    if (req.method === 'GET' && url.pathname === '/@veritasium') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}">`);
      return;
    }
    if (url.pathname === '/@video-page') {
      res.writeHead(200).end('<link rel="canonical" href="https://www.youtube.com/watch?v=x">');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/youtubei/v1/player') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const { videoId, context } = JSON.parse(body);
        const tracks: Record<string, unknown[]> = {
          captioned: [
            {
              baseUrl: `${base}/api/timedtext?v=captioned&lang=en&kind=asr`,
              languageCode: 'en',
              kind: 'asr',
            },
            { baseUrl: `${base}/api/timedtext?v=captioned&lang=en&fmt=srv3`, languageCode: 'en' },
          ],
          empty: [{ baseUrl: `${base}/api/timedtext?v=empty`, languageCode: 'en' }],
          foreign: [{ baseUrl: 'https://evil.example.com/captions', languageCode: 'en' }],
        };
        const playable = videoId !== 'blocked' && context.client.clientName === 'ANDROID';
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            playabilityStatus: playable
              ? { status: 'OK' }
              : { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' },
            ...(tracks[videoId]
              ? {
                  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks[videoId] } },
                }
              : {}),
          }),
        );
      });
      return;
    }
    if (url.pathname === '/api/timedtext') {
      // The written English track, asked for without a format
      const ok = url.searchParams.get('v') === 'captioned' && !url.searchParams.has('kind');
      res.writeHead(200).end(ok && !url.searchParams.has('fmt') ? CAPTIONS : '');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('YouTubeClient', () => {
  let server: Server;
  let client: YouTubeClient;

  beforeAll(async () => {
    server = await startServer();
    client = new YouTubeClient({
      timeoutMs: 5_000,
      maxBytes: 100_000,
      userAgent: 'test',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('finds the channel behind a handle', async () => {
    expect(await client.channelIdOf('https://www.youtube.com/@veritasium')).toBe(CHANNEL_ID);
  });

  it.each(['https://www.youtube.com/@nobody', 'https://www.youtube.com/@video-page'])(
    'refuses %s, which is no channel',
    async (url) => {
      await expect(client.channelIdOf(url)).rejects.toThrow(SourceFetchError);
    },
  );

  it('reads the written captions in the spoken language', async () => {
    expect(await client.transcriptOf('captioned')).toBe('- In 1887, a young teacher it\'s "true"');
  });

  it('has no transcript for a video without captions', async () => {
    expect(await client.transcriptOf('silent')).toBeUndefined();
  });

  it.each([
    ['blocked', 'Sign in to confirm'],
    ['empty', 'came back empty'],
    ['foreign', 'unexpected captions host'],
  ])('fails when the captions of %s cannot be read', async (videoId, message) => {
    await expect(client.transcriptOf(videoId)).rejects.toThrow(message);
  });
});

describe('pickCaptionTrack', () => {
  const track = (languageCode: string, kind?: string) => ({ baseUrl: '', languageCode, kind });

  it('prefers written captions in the spoken language, then generated ones', () => {
    expect(pickCaptionTrack([track('de'), track('en', 'asr'), track('en-GB')])).toEqual(
      track('en-GB'),
    );
    expect(pickCaptionTrack([track('de'), track('en', 'asr')])).toEqual(track('en', 'asr'));
    expect(pickCaptionTrack([track('de')])).toEqual(track('de'));
    expect(pickCaptionTrack([])).toBeUndefined();
  });
});

describe('captionText', () => {
  it('reads format 3 captions too', () => {
    expect(captionText('<timedtext><body><p t="0"><s>Hello</s><s> world</s></p></body>')).toBe(
      'Hello world',
    );
  });
});
