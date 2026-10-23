import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceFetchError } from '../../domain/errors.ts';
import {
  PlaywrightPageFetcher,
  type PlaywrightPageFetcherOptions,
} from './playwright-page-fetcher.ts';

const NO_VALIDATORS = { etag: null, lastModified: null };

/** Pages whose content only exists after their JavaScript ran. */
function startServer(hits: Map<string, number>): Promise<Server> {
  const html = (body: string) => `<!doctype html><html><head><title>SPA</title></head>
    <body><div id="app"></div>${body}</body></html>`;
  const server = createServer((req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    switch (req.url) {
      case '/spa':
        // Content from an XHR, rendered by script, plus an image that should not be loaded
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          html(`<img src="/logo.png"><script>
            fetch('/api/posts').then((r) => r.json()).then((posts) => {
              document.getElementById('app').innerHTML = posts
                .map((p) => '<a class="post" href="/posts/' + p.id + '">' + p.title + '</a>')
                .join('');
            });
          </script>`),
        );
        return;
      case '/api/posts':
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify([{ id: 1, title: 'Rendered post' }]));
        return;
      case '/slow':
        // Appears after the network went quiet: only a selector wait catches it
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          html(`<script>
            setTimeout(() => { document.getElementById('app').innerHTML =
              '<p class="late">Late content</p>'; }, 1500);
          </script>`),
        );
        return;
      case '/moved':
        res.writeHead(302, { location: '/spa' }).end();
        return;
      case '/gone':
        res.writeHead(404, { 'content-type': 'text/html' }).end(html('not here'));
        return;
      case '/busy':
        res.writeHead(503, { 'content-type': 'text/html' }).end(html('busy'));
        return;
      default:
        res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('PlaywrightPageFetcher', () => {
  const hits = new Map<string, number>();
  let server: Server;
  let port: number;
  let base: string;
  const fetchers: PlaywrightPageFetcher[] = [];

  beforeAll(async () => {
    server = await startServer(hits);
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await Promise.all(fetchers.map((f) => f.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const fetcher = (overrides: Partial<PlaywrightPageFetcherOptions> = {}) => {
    const created = new PlaywrightPageFetcher({
      executablePath: process.env.BROWSER_EXECUTABLE_PATH,
      timeoutMs: 10_000,
      maxBytes: 1024 * 1024,
      allowPrivateNetworks: true,
      ...overrides,
    });
    fetchers.push(created);
    return created;
  };

  it('returns the page as rendered by its scripts, without loading images', async () => {
    const result = await fetcher().fetch({ url: `${base}/moved`, validators: NO_VALIDATORS });
    expect(result).toMatchObject({
      status: 'ok',
      url: `${base}/spa`,
      contentType: 'text/html; charset=utf-8',
      validators: NO_VALIDATORS,
    });
    expect(result.status === 'ok' && result.body).toContain(
      '<a class="post" href="/posts/1">Rendered post</a>',
    );
    expect(hits.get('/logo.png')).toBeUndefined();
  });

  it('waits for the given selector', async () => {
    const result = await fetcher().fetch({
      url: `${base}/slow`,
      validators: NO_VALIDATORS,
      waitForSelector: '.late',
    });
    expect(result.status === 'ok' && result.body).toContain('Late content');
  });

  it('fails permanently when the selector never matches', async () => {
    await expect(
      fetcher({ timeoutMs: 3_000 }).fetch({
        url: `${base}/spa`,
        validators: NO_VALIDATORS,
        waitForSelector: '.missing',
      }),
    ).rejects.toThrow(SourceFetchError);
  });

  it('fails permanently on 4xx and transiently on 5xx', async () => {
    const browser = fetcher();
    await expect(browser.fetch({ url: `${base}/gone`, validators: NO_VALIDATORS })).rejects.toThrow(
      new SourceFetchError(`HTTP 404 from ${base}/gone`),
    );
    const busy = await browser
      .fetch({ url: `${base}/busy`, validators: NO_VALIDATORS })
      .catch((err: unknown) => err);
    expect(busy).toBeInstanceOf(Error);
    expect(busy).not.toBeInstanceOf(SourceFetchError);
  });

  it('fails when the rendered page is too large', async () => {
    await expect(
      fetcher({ maxBytes: 100 }).fetch({ url: `${base}/spa`, validators: NO_VALIDATORS }),
    ).rejects.toThrow(/larger than 100 bytes/);
  });

  it('refuses private addresses, also when a hostname resolves to one', async () => {
    const guarded = fetcher({ allowPrivateNetworks: false });
    await expect(guarded.fetch({ url: `${base}/spa`, validators: NO_VALIDATORS })).rejects.toThrow(
      /private or reserved address/,
    );
    // Resolved by the guarded agent that answers the browser's requests
    await expect(
      guarded.fetch({ url: `http://localhost:${port}/spa`, validators: NO_VALIDATORS }),
    ).rejects.toThrow(/resolves to private address/);
  });

  it('survives a closed browser by launching a new one', async () => {
    const browser = fetcher();
    await browser.fetch({ url: `${base}/spa`, validators: NO_VALIDATORS });
    await browser.close();
    const again = await browser.fetch({ url: `${base}/spa`, validators: NO_VALIDATORS });
    expect(again.status).toBe('ok');
  });
});
