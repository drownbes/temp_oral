import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import type { Batch } from 'openai/resources/batches';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BatchClient } from './openai-batch-client.ts';
import { DirectBatchClient, type ResultStore, RoutingBatchClient } from './openai-direct-client.ts';

class MemoryStore implements ResultStore {
  readonly objects = new Map<string, string>();

  async get(key: string) {
    return this.objects.get(key);
  }

  async put(key: string, jsonl: string) {
    this.objects.set(key, jsonl);
  }
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

describe('DirectBatchClient', () => {
  const calls: { path: string; body: { model: string } }[] = [];
  let server: Server;
  let openai: OpenAI;

  beforeAll(async () => {
    // Answers chat completions; model "bad" gets a 400 like the real API
    server = createServer(async (req, res) => {
      const body = JSON.parse(await read(req)) as { model: string };
      calls.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (body.model === 'bad') {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'model not found' } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: body.model } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    openai = new OpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('runs every request now and reads them back as batch result lines', async () => {
    const store = new MemoryStore();
    const client = new DirectBatchClient(openai, store, { concurrency: 2 });

    const ref = await client.submit('digest-1-analysis', '/v1/chat/completions', [
      { customId: 'a', body: { model: 'good-a' } },
      { customId: 'b', body: { model: 'bad' } },
      { customId: 'c', body: { model: 'good-c' } },
    ]);

    expect(ref).toBe('direct:digest-1-analysis');
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/chat/completions',
      '/v1/chat/completions',
      '/v1/chat/completions',
    ]);
    const batch = await client.retrieve(ref);
    expect(batch.status).toBe('completed');
    expect(await client.results(batch)).toEqual([
      {
        customId: 'a',
        statusCode: 200,
        body: { choices: [{ message: { content: 'good-a' } }] },
        error: null,
      },
      {
        customId: 'b',
        statusCode: 400,
        body: { error: { message: 'model not found' } },
        error: 'model not found',
      },
      {
        customId: 'c',
        statusCode: 200,
        body: { choices: [{ message: { content: 'good-c' } }] },
        error: null,
      },
    ]);
  });

  it('does not run a key again once its results are stored', async () => {
    const store = new MemoryStore();
    const client = new DirectBatchClient(openai, store, { concurrency: 2 });
    const before = calls.length;

    await client.submit('k', '/v1/chat/completions', [{ customId: 'a', body: { model: 'x' } }]);
    await client.submit('k', '/v1/chat/completions', [{ customId: 'a', body: { model: 'x' } }]);

    expect(calls.length - before).toBe(1);
  });

  it('reports lost results as a failed batch', async () => {
    const client = new DirectBatchClient(openai, new MemoryStore(), { concurrency: 1 });
    expect(await client.retrieve('direct:gone')).toMatchObject({ status: 'failed' });
  });
});

describe('RoutingBatchClient', () => {
  const fake = (name: string): BatchClient & { submitted: string[] } => {
    const submitted: string[] = [];
    return {
      submitted,
      async submit(key) {
        submitted.push(key);
        return name === 'direct' ? `direct:${key}` : `batch_${key}`;
      },
      async retrieve(id) {
        return { id, status: name === 'direct' ? 'completed' : 'in_progress' } as Batch;
      },
      async results() {
        return [];
      },
    };
  };

  it('submits in the configured mode and follows refs of either mode', async () => {
    const batch = fake('batch');
    const direct = fake('direct');
    const client = new RoutingBatchClient('direct', batch, direct);

    expect(await client.submit('k', '/v1/embeddings', [])).toBe('direct:k');
    expect(direct.submitted).toEqual(['k']);
    expect(batch.submitted).toEqual([]);
    // A batch submitted before switching to direct mode is still followed
    expect((await client.retrieve('batch_old')).status).toBe('in_progress');
    expect((await client.retrieve('direct:k')).status).toBe('completed');
  });
});
