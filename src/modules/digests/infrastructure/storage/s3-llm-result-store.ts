import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ResultStore } from '../llm/openai-direct-client.ts';

/** Direct-mode LLM results under `digests/llm-results/` in the shared bucket. */
export class S3LlmResultStore implements ResultStore {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(s3: S3Client, bucket: string, prefix = 'digests/llm-results/') {
    this.#s3 = s3;
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  async get(key: string): Promise<string | undefined> {
    // A miss is the usual case (results not stored yet). Fetching a missing object answers 404,
    // which the trace shows as a failed call, so list the key first.
    const { KeyCount } = await this.#s3.send(
      new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: this.#key(key), MaxKeys: 1 }),
    );
    if (!KeyCount) return undefined;
    try {
      const { Body } = await this.#s3.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(key) }),
      );
      return (await Body?.transformToString('utf-8')) ?? '';
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      throw err;
    }
  }

  async put(key: string, jsonl: string): Promise<void> {
    const body = new TextEncoder().encode(jsonl);
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: this.#key(key),
        Body: body,
        ContentType: 'application/x-ndjson',
        ContentLength: body.byteLength,
      }),
    );
  }

  #key(key: string): string {
    return `${this.#prefix}${key}.jsonl`;
  }
}
