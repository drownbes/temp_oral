import type OpenAI from 'openai';
import { toFile } from 'openai';
import type { Batch, BatchCreateParams } from 'openai/resources/batches';
import type { BatchState } from '../../application/ports.ts';

export interface BatchRequest {
  readonly customId: string;
  readonly body: unknown;
}

export interface BatchResultLine {
  readonly customId: string;
  /** HTTP status of the individual request; absent when the request errored before running. */
  readonly statusCode: number | null;
  readonly body: unknown;
  readonly error: string | null;
}

/** Batch states that can still produce (or have produced) results. */
const LIVE_STATES = new Set(['validating', 'in_progress', 'finalizing', 'completed']);
/** How far back `submit` looks for a batch with the same key. */
const RECENT_BATCHES = 100;

/** What batch-based analyzers need; lets them be tested without the API. */
export interface BatchClient {
  submit(
    key: string,
    endpoint: BatchCreateParams['endpoint'],
    requests: readonly BatchRequest[],
  ): Promise<string>;
  retrieve(batchId: string): Promise<Batch>;
  results(batch: Batch): Promise<BatchResultLine[]>;
}

/**
 * The only place that knows OpenAI Batch API mechanics: JSONL upload, batch creation,
 * idempotency via metadata, and reading output/error files.
 */
export class OpenAiBatchClient implements BatchClient {
  readonly #openai: OpenAI;

  constructor(openai: OpenAI) {
    this.#openai = openai;
  }

  /**
   * Creates a batch unless a live one with `key` exists (e.g. created by an attempt that
   * crashed before recording it). Returns the batch id.
   */
  async submit(
    key: string,
    endpoint: BatchCreateParams['endpoint'],
    requests: readonly BatchRequest[],
  ): Promise<string> {
    const existing = await this.#findByKey(key);
    if (existing) return existing.id;

    const jsonl = requests
      .map((r) =>
        JSON.stringify({ custom_id: r.customId, method: 'POST', url: endpoint, body: r.body }),
      )
      .join('\n');
    const file = await this.#openai.files.create({
      file: await toFile(Buffer.from(jsonl, 'utf-8'), `${key}.jsonl`, {
        type: 'application/jsonl',
      }),
      purpose: 'batch',
    });
    const batch = await this.#openai.batches.create({
      input_file_id: file.id,
      endpoint,
      completion_window: '24h',
      metadata: { idempotency_key: key },
    });
    return batch.id;
  }

  retrieve(batchId: string): Promise<Batch> {
    return this.#openai.batches.retrieve(batchId);
  }

  /** All result lines: successes (output file) and per-request failures (error file). */
  async results(batch: Batch): Promise<BatchResultLine[]> {
    const files = [batch.output_file_id, batch.error_file_id].filter((id): id is string => !!id);
    const lines: BatchResultLine[] = [];
    for (const fileId of files) {
      const content = await (await this.#openai.files.content(fileId)).text();
      for (const line of content.split('\n')) {
        if (line.trim()) lines.push(parseResultLine(line));
      }
    }
    return lines;
  }

  async #findByKey(key: string): Promise<Batch | undefined> {
    const page = await this.#openai.batches.list({ limit: RECENT_BATCHES });
    return page.data.find((b) => b.metadata?.idempotency_key === key && LIVE_STATES.has(b.status));
  }
}

interface RawLine {
  custom_id: string;
  response?: { status_code?: number; body?: unknown } | null;
  error?: { code?: string; message?: string } | null;
}

/** Parses one line of a batch output or error file. */
export function parseResultLine(line: string): BatchResultLine {
  const raw = JSON.parse(line) as RawLine;
  const statusCode = raw.response?.status_code ?? null;
  const body = raw.response?.body ?? null;
  const bodyError = (body as { error?: { message?: string } } | null)?.error?.message;
  const error =
    raw.error?.message ??
    bodyError ??
    (statusCode !== null && statusCode >= 400 ? `HTTP ${statusCode}` : null);
  return { customId: raw.custom_id, statusCode, body, error };
}

/** OpenAI batch status → what the use cases need to know. */
export function toBatchState(batch: Batch): BatchState {
  switch (batch.status) {
    case 'completed':
      return { state: 'completed' };
    case 'expired':
      return { state: 'incomplete', reason: 'batch expired before finishing' };
    case 'cancelled':
      return { state: 'incomplete', reason: 'batch was cancelled' };
    case 'failed': {
      const errors = batch.errors?.data?.map((e) => e.message).filter(Boolean) ?? [];
      return { state: 'failed', reason: errors.join('; ') || 'batch failed' };
    }
    default:
      // validating, in_progress, finalizing, cancelling
      return { state: 'pending' };
  }
}
