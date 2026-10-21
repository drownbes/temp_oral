import OpenAI from 'openai';
import type { Batch, BatchCreateParams } from 'openai/resources/batches';
import {
  type BatchClient,
  type BatchRequest,
  type BatchResultLine,
  parseResultLine,
} from './openai-batch-client.ts';

/** Durable storage for direct-mode results, so they survive a worker restart before ingest. */
export interface ResultStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, jsonl: string): Promise<void>;
}

export interface DirectBatchClientOptions {
  /** Requests in flight at once; keep well within the account's rate limits. */
  readonly concurrency: number;
}

export const DIRECT_REF_PREFIX = 'direct:';

/**
 * Same contract as the Batch API, but runs every request right away through the normal API
 * (full price, results in seconds): for testing, or steps too small to be worth queueing.
 * Results are written in the Batch API's output-line format, so readers are shared.
 * Idempotent: a key whose results are stored is not run again.
 */
export class DirectBatchClient implements BatchClient {
  readonly #openai: OpenAI;
  readonly #store: ResultStore;
  readonly #options: DirectBatchClientOptions;

  constructor(openai: OpenAI, store: ResultStore, options: DirectBatchClientOptions) {
    this.#openai = openai;
    this.#store = store;
    this.#options = options;
  }

  async submit(
    key: string,
    endpoint: BatchCreateParams['endpoint'],
    requests: readonly BatchRequest[],
  ): Promise<string> {
    const ref = `${DIRECT_REF_PREFIX}${key}`;
    if ((await this.#store.get(key)) !== undefined) return ref;

    // The client's base URL already ends in /v1
    const path = endpoint.replace(/^\/v1/, '');
    const lines = await pool(requests, this.#options.concurrency, (request) =>
      this.#run(path, request),
    );
    await this.#store.put(key, lines.map((line) => JSON.stringify(line)).join('\n'));
    return ref;
  }

  /** Stored results mean the "batch" is complete; anything else means they were lost. */
  async retrieve(batchId: string): Promise<Batch> {
    const stored = await this.#store.get(batchId.slice(DIRECT_REF_PREFIX.length));
    return (
      stored !== undefined
        ? { id: batchId, status: 'completed' }
        : {
            id: batchId,
            status: 'failed',
            errors: { data: [{ message: 'direct results missing' }] },
          }
    ) as Batch;
  }

  async results(batch: Batch): Promise<BatchResultLine[]> {
    const stored = (await this.#store.get(batch.id.slice(DIRECT_REF_PREFIX.length))) ?? '';
    return stored
      .split('\n')
      .filter((line) => line.trim())
      .map(parseResultLine);
  }

  async #run(path: string, request: BatchRequest) {
    try {
      const body = await this.#openai.post(path, { body: request.body as Record<string, unknown> });
      return { custom_id: request.customId, response: { status_code: 200, body }, error: null };
    } catch (err) {
      if (err instanceof OpenAI.APIError && err.status) {
        // Same shape as a failed request inside a batch
        return {
          custom_id: request.customId,
          response: { status_code: err.status, body: { error: err.error } },
          error: null,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { custom_id: request.customId, response: null, error: { message } };
    }
  }
}

/**
 * Batch API for `mode: 'batch'`, direct calls for `mode: 'direct'`. Reads are routed by the
 * ref, so batches submitted before a mode switch are still followed to the end.
 */
export class RoutingBatchClient implements BatchClient {
  readonly #mode: 'batch' | 'direct';
  readonly #batch: BatchClient;
  readonly #direct: BatchClient;

  constructor(mode: 'batch' | 'direct', batch: BatchClient, direct: BatchClient) {
    this.#mode = mode;
    this.#batch = batch;
    this.#direct = direct;
  }

  submit(key: string, endpoint: BatchCreateParams['endpoint'], requests: readonly BatchRequest[]) {
    return (this.#mode === 'direct' ? this.#direct : this.#batch).submit(key, endpoint, requests);
  }

  retrieve(batchId: string): Promise<Batch> {
    return this.#for(batchId).retrieve(batchId);
  }

  results(batch: Batch): Promise<BatchResultLine[]> {
    return this.#for(batch.id).results(batch);
  }

  #for(ref: string): BatchClient {
    return ref.startsWith(DIRECT_REF_PREFIX) ? this.#direct : this.#batch;
  }
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
