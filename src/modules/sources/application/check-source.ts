import { DomainError } from '#shared/kernel/errors.ts';
import {
  InvalidSourceError,
  SourceKindNotSupportedError,
  UnusableSourceError,
} from '../domain/errors.ts';
import type { SourceSnapshot } from '../domain/source.ts';
import type { PreviewSourceCommand, SourcePreview } from './preview-source.ts';

export interface SourceCheckResult {
  /** Problems that may pass (the site is down right now, an article was unreadable). */
  readonly warnings: readonly string[];
}

/**
 * Port: tries a source the way the collector would before it is saved. Throws
 * UnusableSourceError when it clearly cannot work as configured.
 */
export interface SourceChecker {
  check(command: PreviewSourceCommand): Promise<SourceCheckResult>;
}

/** What the check needs from the preview use case. */
export interface SourcePreviewer {
  execute(command: PreviewSourceCommand): Promise<SourcePreview>;
}

/** How the collector reads a source, as a preview command. */
export function previewCommandOf(source: SourceSnapshot): PreviewSourceCommand {
  return {
    url: source.url,
    fetchMode: source.fetchMode,
    waitForSelector: source.waitForSelector,
    ...source.settings,
  };
}

/**
 * Runs the preview and judges it. Refused by the site, not a feed, or nothing to collect
 * (no entries, no matching links, no text) is unusable. A failure that may be temporary
 * (5xx, timeout, no browser worker running) is only a warning: the source is saved, and its
 * first collection will tell.
 */
export class CheckSource implements SourceChecker {
  readonly #previewer: SourcePreviewer;

  constructor(previewer: SourcePreviewer) {
    this.#previewer = previewer;
  }

  async check(command: PreviewSourceCommand): Promise<SourceCheckResult> {
    let preview: SourcePreview;
    try {
      preview = await this.#previewer.execute(command);
    } catch (err) {
      // The settings themselves are wrong: that error says it best
      if (err instanceof InvalidSourceError) throw err;
      // E.g. no browser worker: a deployment matter, not the source's
      if (err instanceof SourceKindNotSupportedError) {
        return { warnings: [`not checked: ${err.message}`] };
      }
      if (err instanceof DomainError) {
        throw new UnusableSourceError(`${command.url} cannot be read: ${err.message}`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      return { warnings: [`not checked, the site did not answer properly: ${reason}`] };
    }

    const problem = nothingToCollect(command, preview);
    if (problem) throw new UnusableSourceError(problem);

    const warnings: string[] = [];
    const sample = preview.articleSample;
    if (sample && 'error' in sample) {
      warnings.push(`${sample.url} could not be read: ${sample.error}`);
    }
    const transcript = preview.transcriptSample;
    if (transcript && 'error' in transcript) {
      warnings.push(
        `no transcript for ${transcript.url} (${transcript.error}); videos without one keep their description`,
      );
    }
    return { warnings };
  }
}

function nothingToCollect(command: PreviewSourceCommand, preview: SourcePreview): string | null {
  // Pages that render with JavaScript are empty over plain HTTP
  const tryBrowser =
    command.fetchMode === 'http'
      ? '; if the site renders with JavaScript, try fetchMode "browser"'
      : '';
  switch (command.kind) {
    case 'feed':
      return preview.entryCount === 0 ? 'the feed has no entries' : null;
    case 'listing':
      return preview.entryCount === 0
        ? `no links on ${preview.url} match the linkSelector / urlPattern${tryBrowser}`
        : null;
    case 'page':
      return preview.pageSample?.chars
        ? null
        : `${preview.url} has no text${command.contentSelector ? ' matching contentSelector' : ''}${tryBrowser}`;
    case 'youtube':
      return preview.entryCount === 0 ? `${preview.url} has no videos (Shorts are left out)` : null;
  }
}
