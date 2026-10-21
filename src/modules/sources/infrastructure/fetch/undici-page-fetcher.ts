import { Agent, fetch, type Response } from 'undici';
import type { FetchRequest, FetchResult, PageFetcher } from '../../application/ports.ts';
import { SourceFetchError } from '../../domain/errors.ts';
import type { FetchValidators } from '../../domain/source.ts';
import { assertPublicHost, guardedLookup } from './address-guard.ts';

export interface UndiciPageFetcherOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly userAgent: string;
  /** Development / tests only: allows loopback and private addresses. */
  readonly allowPrivateNetworks: boolean;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, ' +
  'text/xml;q=0.9, text/html;q=0.8, */*;q=0.5';

/**
 * Plain HTTP fetcher. Redirects are followed by hand so every hop is checked against the
 * address guard; the timeout covers the whole exchange including the body.
 */
export class UndiciPageFetcher implements PageFetcher {
  readonly #options: UndiciPageFetcherOptions;
  readonly #agent: Agent;

  constructor(options: UndiciPageFetcherOptions) {
    this.#options = options;
    this.#agent = new Agent({
      keepAliveTimeout: 4_000,
      connect: options.allowPrivateNetworks ? {} : { lookup: guardedLookup },
    });
  }

  async fetch({ url, validators }: FetchRequest): Promise<FetchResult> {
    const signal = AbortSignal.timeout(this.#options.timeoutMs);
    let current = new URL(url);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!this.#options.allowPrivateNetworks) assertPublicHost(current);
      const response = await this.#send(current, validators, signal);
      const { status } = response;

      if (REDIRECT_STATUSES.has(status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location)
          throw new SourceFetchError(`HTTP ${status} without Location from ${current}`);
        current = new URL(location, current);
        continue;
      }
      if (status === 304) {
        await response.body?.cancel();
        return { status: 'not-modified' };
      }
      if (status === 408 || status === 429 || status >= 500) {
        await response.body?.cancel();
        throw new Error(`HTTP ${status} from ${current}`);
      }
      if (status < 200 || status >= 300) {
        await response.body?.cancel();
        throw new SourceFetchError(`HTTP ${status} from ${current}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      return {
        status: 'ok',
        url: current.href,
        contentType,
        body: decode(await this.#readBody(response, current), contentType),
        validators: {
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        },
      };
    }
    throw new SourceFetchError(`more than ${MAX_REDIRECTS} redirects from ${url}`);
  }

  async #send(url: URL, validators: FetchValidators, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      'user-agent': this.#options.userAgent,
      accept: ACCEPT,
    };
    if (validators.etag) headers['if-none-match'] = validators.etag;
    if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;
    try {
      return await fetch(url, { headers, redirect: 'manual', signal, dispatcher: this.#agent });
    } catch (err) {
      // fetch wraps connect errors, including the address guard's, in "TypeError: fetch failed"
      const cause = err instanceof Error ? err.cause : undefined;
      if (cause instanceof SourceFetchError) throw cause;
      throw err;
    }
  }

  async #readBody(response: Response, url: URL): Promise<Uint8Array> {
    const { maxBytes } = this.#options;
    const tooLarge = () => new SourceFetchError(`${url} is larger than ${maxBytes} bytes`);
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (!response.body) return new Uint8Array();

    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      // Leaving the loop cancels the stream, so the rest is never downloaded
      if (size > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }
}

function decode(body: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
