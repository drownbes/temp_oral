import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceFetchError } from '../../domain/errors.ts';
import { isBlockedAddress } from './address-guard.ts';
import { UndiciPageFetcher, type UndiciPageFetcherOptions } from './undici-page-fetcher.ts';

/** A local server with one route per scenario. */
function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    switch (req.url) {
      case '/feed':
        if (req.headers['if-none-match'] === '"v1"') {
          res.writeHead(304).end();
          return;
        }
        res
          .writeHead(200, {
            'content-type': 'application/rss+xml; charset=iso-8859-1',
            etag: '"v1"',
            'last-modified': 'Tue, 20 Oct 2026 10:00:00 GMT',
          })
          .end(Buffer.from('caf\xe9', 'latin1'));
        return;
      case '/moved':
        res.writeHead(301, { location: '/feed' }).end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' }).end();
        return;
      case '/gone':
        res.writeHead(404).end('not here');
        return;
      case '/busy':
        res.writeHead(503).end();
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('x'.repeat(600));
        res.end('x'.repeat(600));
        return;
      default:
        res.writeHead(500).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('UndiciPageFetcher', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await startServer();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const fetcher = (overrides: Partial<UndiciPageFetcherOptions> = {}) =>
    new UndiciPageFetcher({
      timeoutMs: 5_000,
      maxBytes: 1_000,
      userAgent: 'test',
      allowPrivateNetworks: true,
      ...overrides,
    });
  const get = (path: string, etag: string | null = null, options = {}) =>
    fetcher(options).fetch({ url: `${base}${path}`, validators: { etag, lastModified: null } });

  it('returns the body decoded with the declared charset, plus validators', async () => {
    expect(await get('/feed')).toEqual({
      status: 'ok',
      url: `${base}/feed`,
      contentType: 'application/rss+xml; charset=iso-8859-1',
      body: 'café',
      validators: { etag: '"v1"', lastModified: 'Tue, 20 Oct 2026 10:00:00 GMT' },
    });
  });

  it('sends validators and reports not-modified', async () => {
    expect(await get('/feed', '"v1"')).toEqual({ status: 'not-modified' });
  });

  it('follows redirects and reports the final URL', async () => {
    expect(await get('/moved')).toMatchObject({ status: 'ok', url: `${base}/feed` });
    await expect(get('/loop')).rejects.toThrow(SourceFetchError);
  });

  it('treats 4xx as permanent and 5xx as transient', async () => {
    await expect(get('/gone')).rejects.toThrow(SourceFetchError);
    const transient = await get('/busy').catch((err: unknown) => err);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(SourceFetchError);
  });

  it('stops reading bodies above the size limit', async () => {
    await expect(get('/big')).rejects.toThrow(/larger than 1000 bytes/);
  });

  it('refuses private addresses unless allowed, by literal IP and by DNS name', async () => {
    const strict = { allowPrivateNetworks: false };
    await expect(get('/feed', null, strict)).rejects.toThrow(/private or reserved address/);
    const port = (server.address() as AddressInfo).port;
    await expect(
      fetcher(strict).fetch({
        url: `http://localhost:${port}/feed`,
        validators: { etag: null, lastModified: null },
      }),
    ).rejects.toThrow(/resolves to private address/);
  });
});

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.20.0.1', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['fd12::1', true],
    ['93.184.216.34', false],
    ['2606:2800:220:1::1', false],
    ['example.com', false],
  ])('%s -> %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });
});
