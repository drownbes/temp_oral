import type { Batch } from 'openai/resources/batches';
import type { BatchClient, BatchRequest, BatchResultLine } from '../openai-batch-client.ts';

/** Records submissions and serves canned batch status and result lines. */
export class FakeBatchClient implements BatchClient {
  submitted: { key: string; endpoint: string; requests: readonly BatchRequest[] }[] = [];
  batch: Partial<Batch> = { status: 'completed' };
  lines: BatchResultLine[] = [];

  async submit(key: string, endpoint: string, requests: readonly BatchRequest[]) {
    this.submitted.push({ key, endpoint, requests });
    return 'batch_1';
  }

  async retrieve(): Promise<Batch> {
    return { id: 'batch_1', ...this.batch } as Batch;
  }

  async results(): Promise<BatchResultLine[]> {
    return this.lines;
  }
}

/** A successful result line. */
export const okLine = (customId: string, body: unknown): BatchResultLine => ({
  customId,
  statusCode: 200,
  body,
  error: null,
});

/** A chat completion whose message content is `content`. */
export const completion = (content: string | null, extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: 'stop', message: { content, refusal: null, ...extra } }],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
});
