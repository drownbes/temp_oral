import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3Client } from '#shared/infrastructure/s3/s3.ts';
import { integrationConfig } from '#test/integration-env.ts';
import type { ExportedItem } from '../../contracts/index.ts';
import type { ItemId, ItemSnapshot } from '../../domain/item.ts';
import type { RunId } from '../../domain/run-id.ts';
import { newSourceId } from '../../domain/source.ts';
import { S3ItemContentStore } from './s3-item-content-store.ts';
import { S3ItemExporter } from './s3-item-exporter.ts';

describe('sources S3 storage', () => {
  let s3: S3Client;
  let bucket: string;
  const prefix = `test/sources-${crypto.randomUUID()}/`;
  const sourceId = newSourceId();
  const runId = '2026-10-21' as RunId;

  beforeAll(() => {
    const config = integrationConfig();
    s3 = createS3Client(config);
    bucket = config.s3.bucket;
  });

  afterAll(() => s3.destroy());

  it('stores raw HTML and text under the run, and reads the text back', async () => {
    const store = new S3ItemContentStore(s3, bucket, prefix);
    const itemId = crypto.randomUUID() as ItemId;

    const keys = await store.put(
      { sourceId, runId, itemId },
      { html: '<p>Grüße</p>', text: 'Grüße' },
    );

    expect(keys).toEqual({
      rawKey: `${prefix}raw/${sourceId}/${runId}/${itemId}.html`,
      textKey: `${prefix}raw/${sourceId}/${runId}/${itemId}.txt`,
    });
    expect(await store.readText(keys.textKey)).toBe('Grüße');
  });

  it('writes the run export as JSONL in the contract format', async () => {
    const item: ItemSnapshot = {
      id: crypto.randomUUID() as ItemId,
      sourceId,
      kind: 'article',
      url: 'https://example.com/a',
      title: 'A "quoted"\ntitle',
      publishedAt: new Date('2026-10-20T10:00:00.000Z'),
      discoveredAt: new Date('2026-10-21T06:00:00.000Z'),
      baseline: false,
      content: { rawKey: 'r', textKey: 't' },
      exportedInRun: runId,
    };
    const key = await new S3ItemExporter(s3, bucket, prefix).write(runId, [
      { item, sourceName: 'Example', text: 'line 1\nline 2' },
      { item: { ...item, publishedAt: null }, sourceName: 'Example', text: '' },
    ]);

    expect(key).toBe(`${prefix}exports/${runId}.jsonl`);
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const lines = (await Body?.transformToString())?.trimEnd().split('\n') ?? [];
    expect(lines.map((l) => JSON.parse(l) as ExportedItem)).toEqual([
      {
        itemId: item.id,
        sourceId,
        sourceName: 'Example',
        kind: 'article',
        url: 'https://example.com/a',
        title: 'A "quoted"\ntitle',
        publishedAt: '2026-10-20T10:00:00.000Z',
        text: 'line 1\nline 2',
      },
      expect.objectContaining({ publishedAt: null, text: '' }),
    ]);
  });
});
