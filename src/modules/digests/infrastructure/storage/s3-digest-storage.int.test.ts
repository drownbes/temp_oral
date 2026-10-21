import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportedItem } from '#modules/sources/contracts/index.ts';
import { createS3Client } from '#shared/infrastructure/s3/s3.ts';
import { integrationConfig } from '#test/integration-env.ts';
import type { RunId } from '../../domain/run-id.ts';
import { S3DigestPublisher } from '../publishing/s3-digest-publisher.ts';
import { S3ExportedItemsReader } from './s3-exported-items-reader.ts';

describe('digests S3 adapters', () => {
  let s3: S3Client;
  let bucket: string;
  const prefix = `test/digests-${crypto.randomUUID()}/`;

  beforeAll(() => {
    const config = integrationConfig();
    s3 = createS3Client(config);
    bucket = config.s3.bucket;
  });

  afterAll(() => s3.destroy());

  it('reads a sources export (JSONL in the contract format)', async () => {
    const line: ExportedItem = {
      itemId: 'i-1',
      sourceId: 's-1',
      sourceName: 'Phoronix',
      kind: 'article',
      url: 'https://example.com/1',
      title: 'One',
      publishedAt: '2026-10-21T10:00:00.000Z',
      text: 'Grüße\nzweite Zeile',
    };
    const key = `${prefix}exports/2026-10-21.jsonl`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: `${JSON.stringify(line)}\n${JSON.stringify({ ...line, itemId: 'i-2', publishedAt: null })}\n`,
      }),
    );

    const { kind: _kind, ...item } = line;
    expect(await new S3ExportedItemsReader(s3, bucket).read(key)).toEqual([
      { ...item, publishedAt: new Date('2026-10-21T10:00:00.000Z') },
      { ...item, itemId: 'i-2', publishedAt: null },
    ]);
  });

  it('publishes the rendered page as HTML', async () => {
    const key = `${prefix}latest/index.html`;
    const location = await new S3DigestPublisher(s3, { bucket, key, timezone: 'UTC' }).publish({
      runId: '2026-10-21' as RunId,
      generatedAt: new Date('2026-10-21T06:00:00Z'),
      featured: [],
      alsoNoted: [],
      failedSources: [],
      itemCount: 0,
      analyzedCount: 0,
      failedItemCount: 0,
    });

    expect(location).toBe(`s3://${bucket}/${key}`);
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(object.ContentType).toBe('text/html; charset=utf-8');
    expect(await object.Body?.transformToString()).toContain('Nothing new since the last digest.');
  });
});
