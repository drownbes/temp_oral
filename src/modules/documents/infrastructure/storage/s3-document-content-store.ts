import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { DocumentContentStore } from '../../application/ports.ts';
import type { DocumentId } from '../../domain/document.ts';

/** Documents own the `documents/` prefix of the shared bucket. */
export class S3DocumentContentStore implements DocumentContentStore {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(s3: S3Client, bucket: string, prefix = 'documents/') {
    this.#s3 = s3;
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  async put(id: DocumentId, content: Uint8Array, contentType: string): Promise<void> {
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: this.#key(id),
        Body: content,
        ContentType: contentType,
        ContentLength: content.byteLength,
      }),
    );
  }

  async get(id: DocumentId): Promise<Uint8Array> {
    const { Body } = await this.#s3.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(id) }),
    );
    if (!Body) throw new Error(`empty body for ${this.#key(id)}`);
    return Body.transformToByteArray();
  }

  #key(id: DocumentId): string {
    return `${this.#prefix}${id}`;
  }
}
