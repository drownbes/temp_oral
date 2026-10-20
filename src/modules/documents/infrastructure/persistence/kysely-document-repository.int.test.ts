import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '#shared/infrastructure/db/database.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { integrationConfig } from '#test/integration-env.ts';
import { Document, newDocumentId } from '../../domain/document.ts';
import { KyselyDocumentRepository } from './kysely-document-repository.ts';
import type { DocumentsTables } from './tables.ts';

describe('KyselyDocumentRepository', () => {
  let db: Database;
  let repository: KyselyDocumentRepository;

  beforeAll(() => {
    const config = integrationConfig();
    db = createDatabase(config, createLogger(config, 'test'));
    repository = new KyselyDocumentRepository(db.withTables<DocumentsTables>());
  });

  afterAll(() => db.destroy());

  it('round-trips the aggregate and persists state changes', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const document = Document.upload({
      id: newDocumentId(),
      filename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42,
      uploadedBy: 'ada@example.com',
      now,
    });
    await repository.save(document);
    expect((await repository.findById(document.id))?.toSnapshot()).toEqual(document.toSnapshot());

    document.startProcessing(now);
    document.completeProcessing('abc', now);
    await repository.save(document);
    expect((await repository.findById(document.id))?.toSnapshot()).toMatchObject({
      status: 'processed',
      checksum: 'abc',
    });
  });

  it('returns undefined for unknown ids', async () => {
    expect(await repository.findById(newDocumentId())).toBeUndefined();
  });
});
