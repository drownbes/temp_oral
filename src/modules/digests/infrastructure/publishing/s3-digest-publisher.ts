import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { DigestPage, DigestPublisher } from '../../application/ports.ts';
import { renderDigestPage } from './html-renderer.ts';

export interface S3DigestPublisherOptions {
  readonly bucket: string;
  readonly key: string;
  readonly timezone: string;
}

/** Overwrites the single "latest" page; how it is served (public bucket, CDN) is not our concern. */
export class S3DigestPublisher implements DigestPublisher {
  readonly #s3: S3Client;
  readonly #options: S3DigestPublisherOptions;

  constructor(s3: S3Client, options: S3DigestPublisherOptions) {
    this.#s3 = s3;
    this.#options = options;
  }

  async publish(page: DigestPage): Promise<string> {
    const { bucket, key, timezone } = this.#options;
    const body = new TextEncoder().encode(renderDigestPage(page, { timezone }));
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'text/html; charset=utf-8',
        ContentLength: body.byteLength,
        CacheControl: 'max-age=300',
      }),
    );
    return `s3://${bucket}/${key}`;
  }
}
