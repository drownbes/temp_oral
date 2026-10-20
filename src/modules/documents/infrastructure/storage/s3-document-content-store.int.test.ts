import type { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3Client } from '#shared/infrastructure/s3/s3.ts';
import { integrationConfig } from '#test/integration-env.ts';
import { newDocumentId } from '../../domain/document.ts';
import { S3DocumentContentStore } from './s3-document-content-store.ts';

describe('S3DocumentContentStore', () => {
  let s3: S3Client;
  let store: S3DocumentContentStore;

  beforeAll(() => {
    const config = integrationConfig();
    s3 = createS3Client(config);
    store = new S3DocumentContentStore(s3, config.s3.bucket, 'test/documents/');
  });

  afterAll(() => s3.destroy());

  it('stores and reads back content', async () => {
    const id = newDocumentId();
    const content = new TextEncoder().encode('hello s3');

    await store.put(id, content, 'text/plain');

    expect(new TextDecoder().decode(await store.get(id))).toBe('hello s3');
  });
});
