import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type Route,
} from 'playwright-core';
import { Agent, fetch } from 'undici';
import type { FetchRequest, FetchResult, PageFetcher } from '../../application/ports.ts';
import { SourceFetchError } from '../../domain/errors.ts';
import { assertPublicHost, guardedLookup } from './address-guard.ts';
import { readBody } from './read-body.ts';

export interface PlaywrightPageFetcherOptions {
  /** Chromium binary; Playwright's own when undefined. */
  readonly executablePath: string | undefined;
  /** Navigation plus waiting for the content. */
  readonly timeoutMs: number;
  /** For the rendered page and for each request it makes. */
  readonly maxBytes: number;
  /** Development / tests only: allows loopback and private addresses. */
  readonly allowPrivateNetworks: boolean;
}

/** Not needed to read a page; skipping them saves most of the bandwidth. */
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font']);
/** Hop-by-hop or describing the encoded body, which undici has already decoded. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'transfer-encoding',
  'content-length',
  'accept-encoding',
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);
/** No WebRTC: its UDP traffic would bypass request interception. */
const CHROMIUM_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

const tracer = trace.getTracer('sources.browser');

/**
 * Renders pages in headless Chromium, for sites whose content only exists after JavaScript.
 * One browser per process, launched on first use; every fetch gets a fresh context, so no
 * cookies or storage leak between sources.
 *
 * Every request the page makes (scripts, XHR, redirects) is answered through the same
 * address-guarded undici agent as plain HTTP fetches, so page scripts cannot reach private
 * addresses either. Browser fetches are never conditional: pages always count as modified.
 */
export class PlaywrightPageFetcher implements PageFetcher {
  readonly #options: PlaywrightPageFetcherOptions;
  readonly #agent: Agent;
  #browser: Promise<Browser> | undefined;

  constructor(options: PlaywrightPageFetcherOptions) {
    this.#options = options;
    this.#agent = new Agent({
      keepAliveTimeout: 4_000,
      connect: options.allowPrivateNetworks ? {} : { lookup: guardedLookup },
    });
  }

  fetch(request: FetchRequest): Promise<FetchResult> {
    return tracer.startActiveSpan('browser.fetch', async (span) => {
      span.setAttributes({
        'url.full': request.url,
        'browser.wait_for_selector': request.waitForSelector ?? '',
      });
      try {
        return await this.#render(request);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** Closes the browser; the next fetch would launch a new one. */
  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    await (await browser?.catch(() => undefined))?.close();
  }

  async #render({ url, waitForSelector }: FetchRequest): Promise<FetchResult> {
    const { timeoutMs, maxBytes, allowPrivateNetworks } = this.#options;
    if (!allowPrivateNetworks) assertPublicHost(new URL(url));
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    // Stops requests still being answered once we are done with the page
    const done = new AbortController();

    const context = await (await this.#launch()).newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    try {
      const page = await context.newPage();
      const blocked = await this.#interceptRequests(context, page, done.signal);

      const response = await page
        .goto(url, { waitUntil: 'load', timeout: remaining() })
        .catch((err: unknown) => {
          // The guard refused the page itself (or a redirect of it): permanent
          if (blocked.reason) throw new SourceFetchError(blocked.reason);
          throw err;
        });
      if (!response) throw new Error(`no response for ${url}`);
      const status = response.status();
      if (status === 408 || status === 429 || status >= 500) {
        throw new Error(`HTTP ${status} from ${response.url()}`);
      }
      if (status < 200 || status >= 300) {
        throw new SourceFetchError(`HTTP ${status} from ${response.url()}`);
      }

      await waitForContent(page, waitForSelector ?? null, remaining());
      const body = await page.content();
      if (Buffer.byteLength(body) > maxBytes) {
        throw new SourceFetchError(`${url} is larger than ${maxBytes} bytes once rendered`);
      }
      return {
        status: 'ok',
        url: page.url(),
        contentType: 'text/html; charset=utf-8',
        body,
        validators: { etag: null, lastModified: null },
      };
    } finally {
      done.abort();
      await context.close().catch(() => {});
    }
  }

  #launch(): Promise<Browser> {
    this.#browser ??= chromium
      .launch({ executablePath: this.#options.executablePath, args: CHROMIUM_ARGS })
      .then((browser) => {
        // A crashed browser is replaced on the next fetch
        browser.on('disconnected', () => {
          this.#browser = undefined;
        });
        return browser;
      })
      .catch((err: unknown) => {
        this.#browser = undefined;
        throw err;
      });
    return this.#browser;
  }

  /** Routes all traffic through the guarded agent. Returns why the page itself was blocked. */
  async #interceptRequests(context: BrowserContext, page: Page, signal: AbortSignal) {
    const blocked: { reason?: string } = {};
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route('**/*', async (route) => {
      const request = route.request();
      const isPage = request.isNavigationRequest() && request.frame() === page.mainFrame();
      try {
        if (SKIPPED_RESOURCES.has(request.resourceType()))
          return await route.abort('blockedbyclient');
        await this.#forward(route, signal);
      } catch (err) {
        if (isPage && err instanceof SourceFetchError) blocked.reason = err.message;
        // Fails if the page is already gone; nothing left to answer then
        await route
          .abort(err instanceof SourceFetchError ? 'blockedbyclient' : 'failed')
          .catch(() => {});
      }
    });
    return blocked;
  }

  /** Answers one browser request with a guarded undici request. Redirects go back to the browser. */
  async #forward(route: Route, signal: AbortSignal): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SourceFetchError(`${url.protocol} requests are not allowed`);
    }
    if (!this.#options.allowPrivateNetworks) assertPublicHost(url);

    const headers = Object.entries(await request.allHeaders()).filter(
      ([name]) => !name.startsWith(':') && !DROPPED_REQUEST_HEADERS.has(name),
    );
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method: request.method(),
        headers,
        body: request.postDataBuffer() ?? undefined,
        redirect: 'manual',
        signal,
        dispatcher: this.#agent,
      });
    } catch (err) {
      // fetch wraps connect errors, including the address guard's, in "TypeError: fetch failed"
      const cause = err instanceof Error ? err.cause : undefined;
      if (cause instanceof SourceFetchError) throw cause;
      throw err;
    }

    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name) && name !== 'set-cookie')
        responseHeaders[name] = value;
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) responseHeaders['set-cookie'] = cookies.join('\n');

    await route.fulfill({
      status: response.status,
      headers: responseHeaders,
      body: Buffer.from(await readBody(response, url, this.#options.maxBytes)),
    });
  }
}

/**
 * Waits for the element the source names, or else for the network to go quiet. Pages that
 * keep polling never go quiet; they are read as they are when the time is up.
 */
async function waitForContent(page: Page, selector: string | null, timeout: number) {
  if (selector) {
    try {
      await page.waitForSelector(selector, { state: 'attached', timeout });
    } catch {
      // Usually a selector that does not match this page; retrying will not help
      throw new SourceFetchError(`waitForSelector "${selector}" did not match within ${timeout}ms`);
    }
    return;
  }
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}
