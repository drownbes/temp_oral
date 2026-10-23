import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '#shared/infrastructure/db/database.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { integrationConfig } from '#test/integration-env.ts';
import { DuplicateSourceError } from '../../domain/errors.ts';
import { newSourceId, Source, type SourceSettings } from '../../domain/source.ts';
import { KyselySourceRepository } from './kysely-source-repository.ts';
import type { SourcesTables } from './tables.ts';

const now = new Date('2026-10-21T06:00:00.000Z');

describe('KyselySourceRepository', () => {
  let db: Database;
  let repository: KyselySourceRepository;
  // A fresh owner per test run keeps the shared test database from leaking between runs
  const ownerId = `test-${crypto.randomUUID()}`;

  beforeAll(() => {
    const config = integrationConfig();
    db = createDatabase(config, createLogger(config, 'test'));
    repository = new KyselySourceRepository(db.withTables<SourcesTables>());
  });

  afterAll(() => db.destroy());

  const source = (url: string, settings: SourceSettings = { kind: 'feed', fetchArticles: false }) =>
    Source.create({
      id: newSourceId(),
      ownerId,
      name: 'Example',
      url,
      fetchMode: 'http',
      settings,
      now,
    });

  it('round-trips the aggregate, including kind-specific settings and state', async () => {
    const listing = source('https://example.com/blog', {
      kind: 'listing',
      linkSelector: 'a.post',
      urlPattern: '/posts/',
    });
    await repository.save(listing);
    expect((await repository.findById(listing.id))?.toSnapshot()).toEqual(listing.toSnapshot());

    listing.recordSuccess({ etag: '"v1"', lastModified: 'Tue, 20 Oct 2026 10:00:00 GMT' }, now);
    listing.recordFailure('timeout', now, 1); // stops it: disabled_reason round-trips too
    await repository.save(listing);
    expect((await repository.findById(listing.id))?.toSnapshot()).toEqual(listing.toSnapshot());
  });

  it('enforces one active source per URL, but allows re-adding an archived one', async () => {
    const first = source('https://example.com/feed.xml');
    await repository.save(first);
    await expect(repository.save(source('https://example.com/feed.xml'))).rejects.toThrow(
      DuplicateSourceError,
    );

    first.archive(now);
    await repository.save(first);
    const again = source('https://example.com/feed.xml');
    await repository.save(again);
    expect((await repository.findActiveByUrl(ownerId, again.url))?.id).toBe(again.id);
  });

  it('lists active sources of the owner and collectable ones across owners', async () => {
    const disabled = source('https://example.org/disabled');
    disabled.update({ enabled: false }, now);
    await repository.save(disabled);

    const active = (await repository.listActive(ownerId)).map((s) => s.id);
    expect(active).toContain(disabled.id);

    const collectable = (await repository.listCollectable()).map((s) => s.id);
    expect(collectable).not.toContain(disabled.id);
    expect(await repository.findByIds([disabled.id, newSourceId()])).toHaveLength(1);
  });
});
