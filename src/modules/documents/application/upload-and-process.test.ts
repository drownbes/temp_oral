import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidDocumentError } from '../domain/errors.ts';
import { ProcessDocument } from './process-document.ts';
import {
  fixedClock,
  InMemoryContentStore,
  InMemoryDocumentRepository,
  RecordingScheduler,
} from './testing/fakes.ts';
import { UploadDocument } from './upload-document.ts';

describe('upload and process a document', () => {
  let repository: InMemoryDocumentRepository;
  let contentStore: InMemoryContentStore;
  let scheduler: RecordingScheduler;
  const clock = fixedClock();

  beforeEach(() => {
    repository = new InMemoryDocumentRepository();
    contentStore = new InMemoryContentStore();
    scheduler = new RecordingScheduler();
  });

  const upload = () =>
    new UploadDocument({ repository, contentStore, scheduler, clock }).execute({
      filename: 'hello.txt',
      contentType: 'text/plain',
      content: new TextEncoder().encode('hello'),
      uploadedBy: 'ada@example.com',
    });

  it('stores content, persists the document and schedules processing', async () => {
    const document = await upload();

    expect(document.status).toBe('uploaded');
    expect(contentStore.objects.has(document.id)).toBe(true);
    expect(repository.rows.get(document.id)?.status).toBe('uploaded');
    expect(scheduler.scheduled).toEqual([document.id]);
  });

  it('does not store or schedule invalid documents', async () => {
    await expect(
      new UploadDocument({ repository, contentStore, scheduler, clock }).execute({
        filename: 'empty.txt',
        contentType: 'text/plain',
        content: new Uint8Array(),
        uploadedBy: 'ada@example.com',
      }),
    ).rejects.toThrow(InvalidDocumentError);
    expect(contentStore.objects.size).toBe(0);
    expect(scheduler.scheduled).toEqual([]);
  });

  it('computes the sha256 checksum and is idempotent', async () => {
    const { id } = await upload();
    const process = new ProcessDocument({ repository, contentStore, clock });

    const first = await process.execute(id);
    const second = await process.execute(id);

    expect(first.checksum).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(second).toEqual(first);
    expect(repository.rows.get(id)?.status).toBe('processed');
  });
});
