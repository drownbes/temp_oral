import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '#shared/infrastructure/db/database.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { integrationConfig } from '#test/integration-env.ts';
import { PageSnapshot } from '../../domain/page-watch.ts';
import { newSourceId, Source } from '../../domain/source.ts';
import { KyselyPageSnapshotRepository } from './kysely-page-snapshot-repository.ts';
import { KyselySourceRepository } from './kysely-source-repository.ts';
import type { SourcesTables } from './tables.ts';

describe('KyselyPageSnapshotRepository', () => {
  let db: Database;
  let snapshots: KyselyPageSnapshotRepository;
  let source: Source;
  const now = new Date('2026-10-22T06:00:00.000Z');

  beforeAll(async () => {
    const config = integrationConfig();
    db = createDatabase(config, createLogger(config, 'test'));
    const tables = db.withTables<SourcesTables>();
    snapshots = new KyselyPageSnapshotRepository(tables);
    source = Source.create({
      id: newSourceId(),
      ownerId: `test-${crypto.randomUUID()}`,
      name: 'Kernel',
      url: 'https://kernel.org/',
      fetchMode: 'http',
      settings: { kind: 'page', contentSelector: '#releases' },
      now,
    });
    await new KyselySourceRepository(tables).save(source);
  });

  afterAll(() => db.destroy());

  it('keeps one snapshot per source, replacing it on save', async () => {
    expect(await snapshots.find(source.id)).toBeUndefined();
    const first = PageSnapshot.take({
      sourceId: source.id,
      url: 'https://kernel.org/',
      contentHash: 'aaaa',
      text: 'stable: 7.3.4',
      takenAt: now,
    });
    await snapshots.save(first);
    expect((await snapshots.find(source.id))?.toSnapshot()).toEqual(first.toSnapshot());

    const second = PageSnapshot.take({
      ...first.toSnapshot(),
      contentHash: 'bbbb',
      text: 'stable: 7.3.5',
    });
    await snapshots.save(second);
    expect((await snapshots.find(source.id))?.toSnapshot()).toEqual(second.toSnapshot());
  });
});
