import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiBatchClient } from './openai-batch-client.ts';

/** Just enough of the OpenAI Files + Batches API to exercise the real SDK calls. */
class FakeOpenAi {
  batches: Record<string, unknown>[] = [];
  uploads: string[] = [];
  files: Record<string, string> = {};
  server: Server;

  constructor() {
    this.server = createServer(async (req, res) => {
      const body = await read(req);
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const url = new URL(req.url ?? '/', 'http://x');

      if (req.method === 'GET' && url.pathname === '/v1/batches') {
        return json(200, { object: 'list', data: this.batches, has_more: false });
      }
      if (req.method === 'POST' && url.pathname === '/v1/files') {
        this.uploads.push(body);
        return json(200, { id: `file-${this.uploads.length}`, object: 'file', purpose: 'batch' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/batches') {
        const batch = {
          ...JSON.parse(body),
          id: `batch_${this.batches.length + 1}`,
          object: 'batch',
          status: 'validating',
        };
        this.batches.unshift(batch);
        return json(200, batch);
      }
      const batchMatch = /^\/v1\/batches\/([\w-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && batchMatch) {
        const batch = this.batches.find((b) => b.id === batchMatch[1]);
        return batch ? json(200, batch) : json(404, { error: { message: 'no such batch' } });
      }
      const fileMatch = /^\/v1\/files\/([\w-]+)\/content$/.exec(url.pathname);
      if (req.method === 'GET' && fileMatch?.[1] && this.files[fileMatch[1]] !== undefined) {
        return res.writeHead(200).end(this.files[fileMatch[1]]);
      }
      return json(404, { error: { message: `unexpected ${req.method} ${url.pathname}` } });
    });
  }
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

describe('OpenAiBatchClient', () => {
  const fake = new FakeOpenAi();
  let client: OpenAiBatchClient;

  beforeAll(async () => {
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    const { port } = fake.server.address() as AddressInfo;
    client = new OpenAiBatchClient(
      new OpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 }),
    );
  });

  afterAll(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));

  beforeEach(() => {
    fake.batches = [];
    fake.uploads = [];
    fake.files = {};
  });

  it('uploads a JSONL file and creates a 24h batch tagged with the key', async () => {
    const id = await client.submit('digest-1-enrichment', '/v1/chat/completions', [
      { customId: 'a', body: { model: 'm' } },
      { customId: 'b', body: { model: 'm' } },
    ]);

    expect(id).toBe('batch_1');
    expect(fake.uploads[0]).toContain(
      '{"custom_id":"a","method":"POST","url":"/v1/chat/completions","body":{"model":"m"}}\n' +
        '{"custom_id":"b"',
    );
    expect(fake.batches[0]).toMatchObject({
      input_file_id: 'file-1',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      metadata: { idempotency_key: 'digest-1-enrichment' },
    });
  });

  it('returns the live batch with the same key instead of creating another', async () => {
    const first = await client.submit('k', '/v1/chat/completions', [{ customId: 'a', body: {} }]);
    const second = await client.submit('k', '/v1/chat/completions', [{ customId: 'a', body: {} }]);
    expect(second).toBe(first);
    expect(fake.uploads).toHaveLength(1);

    // A failed batch with that key does not count
    (fake.batches[0] as { status: string }).status = 'failed';
    expect(await client.submit('k', '/v1/chat/completions', [])).toBe('batch_2');
  });

  it('reads successes from the output file and failures from the error file', async () => {
    fake.batches = [
      { id: 'batch_9', status: 'completed', output_file_id: 'out', error_file_id: 'err' },
    ];
    fake.files = {
      out:
        `${JSON.stringify({ custom_id: 'a', response: { status_code: 200, body: { choices: [] } }, error: null })}\n` +
        `${JSON.stringify({ custom_id: 'b', response: { status_code: 400, body: { error: { message: 'bad model' } } }, error: null })}\n`,
      err: `${JSON.stringify({ custom_id: 'c', response: null, error: { code: 'x', message: 'timed out' } })}\n`,
    };

    const lines = await client.results(await client.retrieve('batch_9'));
    expect(lines).toEqual([
      { customId: 'a', statusCode: 200, body: { choices: [] }, error: null },
      {
        customId: 'b',
        statusCode: 400,
        body: { error: { message: 'bad model' } },
        error: 'bad model',
      },
      { customId: 'c', statusCode: null, body: null, error: 'timed out' },
    ]);
  });
});
