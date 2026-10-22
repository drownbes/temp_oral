import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { ExportedItem } from '#modules/sources/contracts/index.ts';
import type { CollectedItem, ExportedItemsReader } from '../../application/ports.ts';

/** Validates each line against the sources contract; a mismatch is a bug, so it throws. */
const ExportedItemLine: z.ZodType<ExportedItem> = z.object({
  itemId: z.string(),
  sourceId: z.string(),
  sourceName: z.string(),
  kind: z.enum(['article', 'change']),
  url: z.string(),
  title: z.string(),
  publishedAt: z.string().nullable(),
  text: z.string(),
});

/** Reads the JSONL export a sources collection run wrote (key from its result). */
export class S3ExportedItemsReader implements ExportedItemsReader {
  readonly #s3: S3Client;
  readonly #bucket: string;

  constructor(s3: S3Client, bucket: string) {
    this.#s3 = s3;
    this.#bucket = bucket;
  }

  async read(exportKey: string): Promise<CollectedItem[]> {
    const { Body } = await this.#s3.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: exportKey }),
    );
    const body = (await Body?.transformToString('utf-8')) ?? '';
    return body
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const item = ExportedItemLine.parse(JSON.parse(line));
        return {
          itemId: item.itemId,
          kind: item.kind,
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          url: item.url,
          title: item.title,
          publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
          text: item.text,
        };
      });
  }
}
