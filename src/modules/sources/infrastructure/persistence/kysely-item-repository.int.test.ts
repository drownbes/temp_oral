import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '#shared/infrastructure/db/database.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { integrationConfig } from '#test/integration-env.ts';
import { Item, itemIdFor } from '../../domain/item.ts';
import type { RunId } from '../../domain/run-id.ts';
import { newSourceId, Source } from '../../domain/source.ts';
import { KyselyItemRepository } from './kysely-item-repository.ts';
import { KyselySourceRepository } from './kysely-source-repository.ts';
import type { SourcesTables } from './tables.ts';

const now = new Date('2026-10-21T06:00:00.000Z');
// Claims are global, so tests use run ids no other run (or earlier test run) has used
const freshRun = () => `test-${crypto.randomUUID()}` as RunId;

describe('KyselyItemRepository', () => {
  let db: Database;
  let items: KyselyItemRepository;
  let source: Source;

  beforeAll(async () => {
    const config = integrationConfig();
    db = createDatabase(config, createLogger(config, 'test'));
    const tables = db.withTables<SourcesTables>();
    items = new KyselyItemRepository(tables);
    source = Source.create({
      id: newSourceId(),
      ownerId: `test-${crypto.randomUUID()}`,
      name: 'Example',
      url: 'https://example.com/feed.xml',
      fetchMode: 'http',
      settings: { kind: 'feed', fetchArticles: true },
      now,
    });
    await new KyselySourceRepository(tables).save(source);
    // Earlier test runs may have left unclaimed items behind
    await items.claimForRun(freshRun());
  });

  afterAll(() => db.destroy());

  const item = async (path: string, baseline = false) => {
    const url = `https://example.com${path}`;
    const id = await itemIdFor(source.id, url);
    return Item.discover({
      id,
      sourceId: source.id,
      url,
      title: path,
      publishedAt: now,
      baseline,
      content: { rawKey: `raw/${id}.html`, textKey: `raw/${id}.txt` },
      now,
    });
  };

  it('adds items idempotently and knows their URLs', async () => {
    const a = await item('/a');
    await items.addNew([a]);
    await items.addNew([a, await item('/b')]);

    const known = await items.knownUrls(source.id, [
      'https://example.com/a',
      'https://example.com/zzz',
    ]);
    expect([...known]).toEqual(['https://example.com/a']);
    const listed = await items.listBySource(source.id, 10);
    expect(listed.map((i) => i.toSnapshot().title).sort()).toEqual(['/a', '/b']);
    expect(listed.find((i) => i.id === a.id)?.toSnapshot()).toEqual(a.toSnapshot());
  });

  it('claims unclaimed, non-baseline items for one run only', async () => {
    await items.addNew([await item('/c'), await item('/baseline', true)]);
    const run = freshRun();

    const claimed = await items.claimForRun(run);
    const titles = claimed.map((i) => i.toSnapshot().title);
    expect(titles).toContain('/c');
    expect(titles).not.toContain('/baseline');
    expect(claimed.every((i) => i.toSnapshot().exportedInRun === run)).toBe(true);

    // Same run again returns the same items; another run gets none of them
    expect((await items.claimForRun(run)).map((i) => i.id)).toEqual(claimed.map((i) => i.id));
    expect(await items.claimForRun(freshRun())).toEqual([]);
  });

  it('never hands an item to two concurrent runs', async () => {
    await items.addNew(await Promise.all(['/d1', '/d2', '/d3'].map((p) => item(p))));
    const [first, second] = await Promise.all([
      items.claimForRun(freshRun()),
      items.claimForRun(freshRun()),
    ]);
    const ids = [...first, ...second].map((i) => i.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});
