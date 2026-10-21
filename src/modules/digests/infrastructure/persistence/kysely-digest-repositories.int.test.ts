import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '#shared/infrastructure/db/database.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { integrationConfig } from '#test/integration-env.ts';
import { Digest, newDigestId } from '../../domain/digest.ts';
import type { DigestEntry } from '../../domain/digest-entry.ts';
import { InterestProfile } from '../../domain/interest-profile.ts';
import { parseRunId } from '../../domain/run-id.ts';
import { KyselyDigestEntryRepository } from './kysely-digest-entry-repository.ts';
import { KyselyDigestRepository } from './kysely-digest-repository.ts';
import { KyselyInterestProfileRepository } from './kysely-interest-profile-repository.ts';
import type { DigestsTables } from './tables.ts';

const now = new Date('2026-10-21T06:00:00.000Z');

describe('digests repositories', () => {
  let db: Database;
  let digests: KyselyDigestRepository;
  let entries: KyselyDigestEntryRepository;
  let profiles: KyselyInterestProfileRepository;
  // A fresh owner per test run keeps the shared test database from leaking between runs
  const ownerId = `test-${crypto.randomUUID()}`;

  beforeAll(() => {
    const config = integrationConfig();
    db = createDatabase(config, createLogger(config, 'test'));
    const tables = db.withTables<DigestsTables>();
    digests = new KyselyDigestRepository(tables);
    entries = new KyselyDigestEntryRepository(tables);
    profiles = new KyselyInterestProfileRepository(tables);
  });

  afterAll(() => db.destroy());

  const digest = (runId: string) =>
    Digest.begin({ id: newDigestId(), ownerId, runId: parseRunId(runId), now });

  it('round-trips a digest through its whole lifecycle', async () => {
    const d = digest('2026-10-21');
    await digests.save(d);
    expect((await digests.findById(d.id))?.toSnapshot()).toEqual(d.toSnapshot());

    d.recordCollection(
      {
        exportKey: 'sources/exports/2026-10-21.jsonl',
        itemCount: 2,
        failedSources: [{ sourceId: 's-1', reason: 'HTTP 404' }],
      },
      now,
    );
    d.enrichmentSubmitted('batch_1', now);
    d.completeEnrichment(
      { analyzedCount: 1, failedItemCount: 1, usage: { inputTokens: 500, outputTokens: 80 } },
      now,
    );
    d.publish(now);
    await digests.save(d);

    expect((await digests.findById(d.id))?.toSnapshot()).toEqual(d.toSnapshot());
    expect((await digests.findByRun(ownerId, parseRunId('2026-10-21')))?.id).toBe(d.id);
  });

  it('finds the latest published run and lists newest first', async () => {
    const older = digest('2026-10-18');
    older.recordCollection({ exportKey: 'k', itemCount: 0, failedSources: [] }, now);
    older.publish(now);
    const unpublished = digest('2026-10-30');
    await digests.save(older);
    await digests.save(unpublished);

    expect(await digests.latestPublishedRunId(ownerId)).toBe('2026-10-21');
    const recent = (await digests.listRecent(ownerId, 2)).map((d) => d.toSnapshot().runId);
    expect(recent).toEqual(['2026-10-30', '2026-10-21']);
  });

  it('upserts entries with and without analysis', async () => {
    const d = digest('2026-10-25');
    await digests.save(d);
    const base: DigestEntry = {
      digestId: d.id,
      itemId: 'item-1',
      sourceId: 's-1',
      sourceName: 'Phoronix',
      url: 'https://example.com/1',
      title: 'One',
      publishedAt: now,
      analysis: null,
      failure: 'not analysed',
    };
    await entries.saveAll([base, { ...base, itemId: 'item-2', publishedAt: null }]);
    const analysed = {
      ...base,
      analysis: { summary: 'S', relevance: 0.75, reason: 'R', tags: ['linux', 'gpu'] },
      failure: null,
    };
    await entries.saveAll([analysed]);

    expect(await entries.listByDigest(d.id)).toEqual([
      analysed,
      { ...base, itemId: 'item-2', publishedAt: null },
    ]);
  });

  it('stores one interest profile per owner', async () => {
    expect(await profiles.find(ownerId)).toBeUndefined();
    const profile = InterestProfile.initial(ownerId, now);
    profile.change({ interests: 'Linux, GPUs', relevanceThreshold: 0.25 }, now);
    await profiles.save(profile);
    profile.change({ relevanceThreshold: 0.75 }, now);
    await profiles.save(profile);

    expect((await profiles.find(ownerId))?.toSnapshot()).toEqual(profile.toSnapshot());
  });
});
