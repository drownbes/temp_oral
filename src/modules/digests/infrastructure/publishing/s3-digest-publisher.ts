import { posix } from 'node:path';
import { ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { DigestPage, DigestPublisher } from '../../application/ports.ts';
import type { RunId } from '../../domain/run-id.ts';
import { renderArchiveIndex, renderDigestPage } from './html-renderer.ts';

export interface S3DigestPublisherOptions {
  readonly bucket: string;
  /** The "latest" page, overwritten by each newer day. */
  readonly key: string;
  /** Every day's page is kept as `<archivePrefix><runId>.html`, next to `index.html`. */
  readonly archivePrefix: string;
  readonly timezone: string;
}

const ARCHIVED_DAY = /^(\d{4}-\d{2}-\d{2})\.html$/;

/**
 * Writes the day's page to the archive, rebuilds the archive index from what is archived (so
 * it never links a missing page), then replaces the "latest" page if asked. Links between
 * the pages are relative, so they work wherever the bucket is served from. How it is served
 * (public bucket, CDN) is not our concern.
 */
export class S3DigestPublisher implements DigestPublisher {
  readonly #s3: S3Client;
  readonly #options: S3DigestPublisherOptions;

  constructor(s3: S3Client, options: S3DigestPublisherOptions) {
    this.#s3 = s3;
    this.#options = options;
  }

  async publish(page: DigestPage, options: { readonly latest: boolean }): Promise<string> {
    const { key, timezone } = this.#options;
    const dayKey = this.#dayKey(page.runId);
    const indexKey = this.#indexKey();
    const render = (at: string) =>
      renderDigestPage(page, { timezone, archiveHref: relativeHref(at, indexKey) });

    await this.#put(dayKey, render(dayKey));
    const days = await this.#archivedDays();
    await this.#put(
      indexKey,
      renderArchiveIndex(days, { dayHref: (runId) => relativeHref(indexKey, this.#dayKey(runId)) }),
    );
    if (options.latest) await this.#put(key, render(key));
    return `s3://${this.#options.bucket}/${dayKey}`;
  }

  #dayKey(runId: RunId): string {
    return `${this.#options.archivePrefix}${runId}.html`;
  }

  #indexKey(): string {
    return `${this.#options.archivePrefix}index.html`;
  }

  async #archivedDays(): Promise<RunId[]> {
    const { bucket, archivePrefix } = this.#options;
    const days: RunId[] = [];
    let token: string | undefined;
    do {
      const page = await this.#s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: archivePrefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        const day = object.Key?.slice(archivePrefix.length).match(ARCHIVED_DAY)?.[1];
        if (day) days.push(day as RunId);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return days;
  }

  async #put(key: string, html: string): Promise<void> {
    const body = new TextEncoder().encode(html);
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#options.bucket,
        Key: key,
        Body: body,
        ContentType: 'text/html; charset=utf-8',
        ContentLength: body.byteLength,
        CacheControl: 'max-age=300',
      }),
    );
  }
}

/** The link from the object at `from` to the object at `to`, both keys in one bucket. */
export function relativeHref(from: string, to: string): string {
  return posix.relative(posix.dirname(`/${from}`), `/${to}`);
}
