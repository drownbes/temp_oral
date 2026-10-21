import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { ItemContentLocation, ItemContentStore } from '../../application/ports.ts';
import type { ItemContentKeys } from '../../domain/item.ts';

/** Sources own the `sources/` prefix of the shared bucket; raw content lives under `raw/`. */
export class S3ItemContentStore implements ItemContentStore {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(s3: S3Client, bucket: string, prefix = 'sources/') {
    this.#s3 = s3;
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  async put(
    { sourceId, runId, itemId }: ItemContentLocation,
    content: { html: string; text: string },
  ): Promise<ItemContentKeys> {
    const base = `${this.#prefix}raw/${sourceId}/${runId}/${itemId}`;
    const keys = { rawKey: `${base}.html`, textKey: `${base}.txt` };
    await Promise.all([
      this.#putText(keys.rawKey, content.html, 'text/html; charset=utf-8'),
      this.#putText(keys.textKey, content.text, 'text/plain; charset=utf-8'),
    ]);
    return keys;
  }

  async readText(key: string): Promise<string> {
    const { Body } = await this.#s3.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!Body) throw new Error(`empty body for ${key}`);
    return Body.transformToString('utf-8');
  }

  async #putText(key: string, text: string, contentType: string): Promise<void> {
    const body = new TextEncoder().encode(text);
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }
}
