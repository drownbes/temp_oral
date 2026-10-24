import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportedItem } from '#modules/sources/contracts/index.ts';
import { createS3Client } from '#shared/infrastructure/s3/s3.ts';
import { integrationConfig } from '#test/integration-env.ts';
import type { RunId } from '../../domain/run-id.ts';
import { S3DigestPublisher } from '../publishing/s3-digest-publisher.ts';
import { S3ExportedItemsReader } from './s3-exported-items-reader.ts';
import { S3LlmResultStore } from './s3-llm-result-store.ts';

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
        Body: `${JSON.stringify(line)}\n${JSON.stringify({ ...line, itemId: 'i-2', kind: 'change', publishedAt: null })}\n`,
      }),
    );

    expect(await new S3ExportedItemsReader(s3, bucket).read(key)).toEqual([
      { ...line, publishedAt: new Date('2026-10-21T10:00:00.000Z') },
      { ...line, itemId: 'i-2', kind: 'change', publishedAt: null },
    ]);
  });

  it('archives every day, indexes the archive and replaces the latest page only when asked', async () => {
    const key = `${prefix}latest/index.html`;
    const archivePrefix = `${prefix}archive/`;
    const publisher = new S3DigestPublisher(s3, { bucket, key, archivePrefix, timezone: 'UTC' });
    const page = (runId: string) => ({
      runId: runId as RunId,
      generatedAt: new Date(`${runId}T06:00:00Z`),
      overview: null,
      featured: [],
      alsoNoted: [],
      repeated: [],
      failedSources: [],
      itemCount: 0,
      analyzedCount: 0,
      failedItemCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    const read = async (at: string) => {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: at }));
      expect(object.ContentType).toBe('text/html; charset=utf-8');
      return (await object.Body?.transformToString()) ?? '';
    };

    expect(await publisher.publish(page('2026-10-22'), { latest: true })).toBe(
      `s3://${bucket}/${archivePrefix}2026-10-22.html`,
    );
    // A late day: archived and indexed, but the latest page stays on the newer day
    await publisher.publish(page('2026-10-21'), { latest: false });

    expect(await read(key)).toContain('Thursday, 22 October 2026');
    expect(await read(key)).toContain('<a href="../archive/index.html">All digests</a>');
    expect(await read(`${archivePrefix}2026-10-21.html`)).toContain(
      'Nothing new since the last digest.',
    );
    expect(await read(`${archivePrefix}2026-10-21.html`)).toContain('<a href="index.html">');
    const index = await read(`${archivePrefix}index.html`);
    expect(index).toContain('<p class="meta">2 days</p>');
    expect(index).toContain('<a href="2026-10-22.html">');
    expect(index).toContain('<a href="2026-10-21.html">');
  });
});

describe('S3LlmResultStore', () => {
  it('stores direct-mode results and reports missing keys as undefined', async () => {
    const config = integrationConfig();
    const s3 = createS3Client(config);
    const store = new S3LlmResultStore(s3, config.s3.bucket, `test/llm-${crypto.randomUUID()}/`);
    try {
      expect(await store.get('digest-1-analysis')).toBeUndefined();
      await store.put('digest-1-analysis', '{"custom_id":"a"}\n{"custom_id":"b"}');
      expect(await store.get('digest-1-analysis')).toBe('{"custom_id":"a"}\n{"custom_id":"b"}');
    } finally {
      s3.destroy();
    }
  });
});
