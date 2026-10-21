import { InvalidSourceError } from '../domain/errors.ts';
import type { FetchMode, SourceKind, SourceSettingsInput } from '../domain/source.ts';
import { sourceSettings } from '../domain/source.ts';
import { canonicalizeUrl } from '../domain/url.ts';
import type { FeedReader, PageFetcher } from './ports.ts';
import { assertSupported } from './supported-sources.ts';

export interface PreviewSourceCommand extends SourceSettingsInput {
  readonly url: string;
  readonly kind: SourceKind;
  readonly fetchMode: FetchMode;
}

export interface PreviewEntry {
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly excerpt: string;
}

export interface SourcePreview {
  /** After redirects. */
  readonly url: string;
  readonly entryCount: number;
  readonly entries: readonly PreviewEntry[];
}

export interface PreviewSourceDeps {
  readonly fetcher: PageFetcher;
  readonly feedReader: FeedReader;
}

const MAX_ENTRIES = 20;
const EXCERPT_LENGTH = 300;

/** Fetches and extracts a source without storing anything, to check its configuration. */
export class PreviewSource {
  readonly #deps: PreviewSourceDeps;

  constructor(deps: PreviewSourceDeps) {
    this.#deps = deps;
  }

  async execute(command: PreviewSourceCommand): Promise<SourcePreview> {
    const settings = sourceSettings(command.kind, command);
    assertSupported(settings.kind, command.fetchMode);
    const url = canonicalizeUrl(command.url);
    if (!url) throw new InvalidSourceError('url must be an absolute http(s) URL');

    const page = await this.#deps.fetcher.fetch({
      url,
      validators: { etag: null, lastModified: null },
    });
    if (page.status !== 'ok') throw new Error('unconditional fetch returned not-modified');

    const entries = this.#deps.feedReader.read(page.body, page.url);
    return {
      url: page.url,
      entryCount: entries.length,
      entries: entries.slice(0, MAX_ENTRIES).map((e) => ({
        url: e.url,
        title: e.title,
        publishedAt: e.publishedAt,
        excerpt: e.text.slice(0, EXCERPT_LENGTH),
      })),
    };
  }
}
