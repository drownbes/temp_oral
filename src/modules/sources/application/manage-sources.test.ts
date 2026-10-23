import { beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateSourceError,
  InvalidSourceError,
  SourceFetchError,
  SourceKindNotSupportedError,
  SourceNotFoundError,
  UnusableSourceError,
} from '../domain/errors.ts';
import { ArchiveSource } from './archive-source.ts';
import { CheckSource, type SourcePreviewer } from './check-source.ts';
import { CreateSource, type CreateSourceCommand } from './create-source.ts';
import { GetSource } from './get-source.ts';
import { ListSources } from './list-sources.ts';
import type { PreviewSourceCommand, SourcePreview } from './preview-source.ts';
import {
  FakeYouTube,
  InMemorySourceRepository,
  mutableClock,
  PassingSourceChecker,
} from './testing/fakes.ts';
import { UpdateSource } from './update-source.ts';

describe('managing sources', () => {
  let repository: InMemorySourceRepository;
  let checker: PassingSourceChecker;
  const clock = mutableClock();

  beforeEach(() => {
    repository = new InMemorySourceRepository();
    checker = new PassingSourceChecker();
  });

  const create = (overrides: Partial<CreateSourceCommand> = {}) =>
    new CreateSource({ repository, checker, channels: new FakeYouTube(), clock })
      .execute({
        ownerId: 'default',
        name: 'Example',
        url: 'https://example.com/feed.xml',
        kind: 'feed',
        fetchMode: 'http',
        ...overrides,
      })
      .then((r) => r.source);

  it('creates a source and lists it', async () => {
    const source = await create();
    expect(source).toMatchObject({
      name: 'Example',
      settings: { kind: 'feed', fetchArticles: true },
      enabled: true,
    });
    expect(await new ListSources(repository).execute('default')).toEqual([source]);
    expect(await new ListSources(repository).execute('someone-else')).toEqual([]);
  });

  it('rejects a second source with the same canonical URL', async () => {
    await create();
    await expect(create({ url: 'https://EXAMPLE.com/feed.xml?utm_source=x' })).rejects.toThrow(
      DuplicateSourceError,
    );
  });

  it('creates browser sources with the element to wait for', async () => {
    expect(await create({ fetchMode: 'browser', waitForSelector: '.news' })).toMatchObject({
      fetchMode: 'browser',
      waitForSelector: '.news',
    });
  });

  it('creates listing and page sources; a listing needs a selector or a pattern', async () => {
    await expect(create({ kind: 'listing', url: 'https://example.com/blog/' })).rejects.toThrow(
      InvalidSourceError,
    );
    expect(
      await create({ kind: 'listing', url: 'https://example.com/blog/', linkSelector: 'h2 a' }),
    ).toMatchObject({ settings: { kind: 'listing', linkSelector: 'h2 a', urlPattern: null } });
    expect(
      await create({ kind: 'page', url: 'https://kernel.org/', contentSelector: '#releases' }),
    ).toMatchObject({ settings: { kind: 'page', contentSelector: '#releases' } });
  });

  it('validates before checking support', async () => {
    await expect(create({ url: 'nope' })).rejects.toThrow(InvalidSourceError);
  });

  it('updates fields and refuses to take over another source URL', async () => {
    const first = await create();
    const second = await create({ url: 'https://example.org/rss' });
    const update = new UpdateSource({ repository, checker, channels: new FakeYouTube(), clock });

    const { source } = await update.execute(first.id, { name: 'Renamed', enabled: false });
    expect(source).toMatchObject({ name: 'Renamed', enabled: false, url: first.url });
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

/** Answers every preview with `answer`; records the commands. */
class StubPreviewer implements SourcePreviewer {
  readonly commands: PreviewSourceCommand[] = [];
  answer: Partial<SourcePreview> | Error = {};

  async execute(command: PreviewSourceCommand): Promise<SourcePreview> {
    this.commands.push(command);
    if (this.answer instanceof Error) throw this.answer;
    return {
      url: command.url,
      entryCount: 3,
      entries: [],
      articleSample: null,
      pageSample: { title: '', chars: 120, lines: 4, excerpt: '' },
      transcriptSample: null,
      ...this.answer,
    };
  }
}

describe('checking a source before it is saved', () => {
  let repository: InMemorySourceRepository;
  let previewer: StubPreviewer;
  const clock = mutableClock();

  beforeEach(() => {
    repository = new InMemorySourceRepository();
    previewer = new StubPreviewer();
  });

  const checker = () => new CheckSource(previewer);
  const create = (overrides: Partial<CreateSourceCommand> = {}) =>
    new CreateSource({
      repository,
      checker: checker(),
      channels: new FakeYouTube(),
      clock,
    }).execute({
      ownerId: 'default',
      name: 'Example',
      url: 'https://example.com/news/',
      kind: 'listing',
      fetchMode: 'http',
      urlPattern: '/news/\\d+',
      ...overrides,
    });

  it('tries the source the way the collector reads it', async () => {
    expect(await create({ fetchMode: 'browser', waitForSelector: 'main' })).toMatchObject({
      warnings: [],
    });
    expect(previewer.commands).toEqual([
      {
        url: 'https://example.com/news/',
        kind: 'listing',
        fetchMode: 'browser',
        waitForSelector: 'main',
        linkSelector: null,
        urlPattern: '/news/\\d+',
      },
    ]);
  });

  it('refuses a source the site will not serve, and saves nothing', async () => {
    previewer.answer = new SourceFetchError('HTTP 403 from https://example.com/news/');
    await expect(create()).rejects.toThrow(
      new UnusableSourceError(
        'https://example.com/news/ cannot be read: HTTP 403 from https://example.com/news/',
      ),
    );
    expect(repository.rows.size).toBe(0);
  });

  it('refuses sources with nothing to collect; suggests the browser for HTTP ones', async () => {
    previewer.answer = { entryCount: 0, pageSample: null };
    await expect(create()).rejects.toThrow(
      'no links on https://example.com/news/ match the linkSelector / urlPattern; if the site renders with JavaScript, try fetchMode "browser"',
    );
    await expect(create({ kind: 'feed' })).rejects.toThrow('the feed has no entries');
    await expect(
      create({ kind: 'page', contentSelector: '#x', fetchMode: 'browser' }),
    ).rejects.toThrow(
      new UnusableSourceError('https://example.com/news/ has no text matching contentSelector'),
    );
  });

  it('saves with a warning when the failure may be temporary', async () => {
    previewer.answer = new Error('HTTP 503 from https://example.com/news/');
    expect((await create()).warnings).toEqual([
      'not checked, the site did not answer properly: HTTP 503 from https://example.com/news/',
    ]);

    previewer.answer = new SourceKindNotSupportedError('no browser worker took the page');
    expect((await create({ url: 'https://example.org/', fetchMode: 'browser' })).warnings).toEqual([
      'not checked: no browser worker took the page',
    ]);
    expect(repository.rows.size).toBe(2);
  });

  it('warns when the first article cannot be read', async () => {
    previewer.answer = {
      articleSample: {
        url: 'https://example.com/news/1',
        error: 'no readable article on the page',
      },
    };
    expect((await create()).warnings).toEqual([
      'https://example.com/news/1 could not be read: no readable article on the page',
    ]);
  });

  it('skips the check when asked', async () => {
    previewer.answer = { entryCount: 0 };
    expect((await create({ skipCheck: true })).source.url).toBe('https://example.com/news/');
    expect(previewer.commands).toEqual([]);
  });

  it('checks an update only when how the source is read changes', async () => {
    const { source } = await create();
    const update = new UpdateSource({
      repository,
      checker: checker(),
      channels: new FakeYouTube(),
      clock,
    });
    previewer.commands.length = 0;

    await update.execute(source.id, { name: 'Renamed' });
    await update.execute(source.id, { enabled: false });
    expect(previewer.commands).toEqual([]);

    await update.execute(source.id, { enabled: true, urlPattern: '/posts/\\d+' });
    expect(previewer.commands.map((c) => c.urlPattern)).toEqual(['/posts/\\d+']);

    previewer.answer = { entryCount: 0 };
    await expect(update.execute(source.id, { urlPattern: '/nothing/' })).rejects.toThrow(
      UnusableSourceError,
    );
    expect(repository.rows.get(source.id)?.settings).toMatchObject({ urlPattern: '/posts/\\d+' });
  });
});
