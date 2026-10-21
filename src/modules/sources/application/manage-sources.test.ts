import { beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateSourceError,
  InvalidSourceError,
  SourceKindNotSupportedError,
  SourceNotFoundError,
} from '../domain/errors.ts';
import { ArchiveSource } from './archive-source.ts';
import { CreateSource, type CreateSourceCommand } from './create-source.ts';
import { GetSource } from './get-source.ts';
import { ListSources } from './list-sources.ts';
import { InMemorySourceRepository, mutableClock } from './testing/fakes.ts';
import { UpdateSource } from './update-source.ts';

describe('managing sources', () => {
  let repository: InMemorySourceRepository;
  const clock = mutableClock();

  beforeEach(() => {
    repository = new InMemorySourceRepository();
  });

  const create = (overrides: Partial<CreateSourceCommand> = {}) =>
    new CreateSource({ repository, clock }).execute({
      ownerId: 'default',
      name: 'Example',
      url: 'https://example.com/feed.xml',
      kind: 'feed',
      fetchMode: 'http',
      ...overrides,
    });

  it('creates a source and lists it', async () => {
    const source = await create();
    expect(source).toMatchObject({ name: 'Example', settings: { kind: 'feed' }, enabled: true });
    expect(await new ListSources(repository).execute('default')).toEqual([source]);
    expect(await new ListSources(repository).execute('someone-else')).toEqual([]);
  });

  it('rejects a second source with the same canonical URL', async () => {
    await create();
    await expect(create({ url: 'https://EXAMPLE.com/feed.xml?utm_source=x' })).rejects.toThrow(
      DuplicateSourceError,
    );
  });

  it.each([
    [{ kind: 'listing' as const }],
    [{ kind: 'page' as const }],
    [{ fetchMode: 'browser' as const }],
  ])('rejects source types this version cannot collect: %o', async (overrides) => {
    await expect(create(overrides)).rejects.toThrow(SourceKindNotSupportedError);
    expect(repository.rows.size).toBe(0);
  });

  it('validates before checking support', async () => {
    await expect(create({ url: 'nope' })).rejects.toThrow(InvalidSourceError);
  });

  it('updates fields and refuses to take over another source URL', async () => {
    const first = await create();
    const second = await create({ url: 'https://example.org/rss' });
    const update = new UpdateSource({ repository, clock });

    expect(await update.execute(first.id, { name: 'Renamed', enabled: false })).toMatchObject({
      name: 'Renamed',
      enabled: false,
      url: first.url,
    });
    await expect(update.execute(second.id, { url: first.url })).rejects.toThrow(
      DuplicateSourceError,
    );
  });

  it('archives a source: it disappears and its URL can be used again', async () => {
    const source = await create();
    await new ArchiveSource({ repository, clock }).execute(source.id);

    await expect(new GetSource(repository).execute(source.id)).rejects.toThrow(SourceNotFoundError);
    expect(await new ListSources(repository).execute('default')).toEqual([]);
    await expect(create()).resolves.toMatchObject({ url: source.url });
  });
});
