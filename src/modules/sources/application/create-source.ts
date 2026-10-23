import type { Clock } from '#shared/kernel/clock.ts';
import { DuplicateSourceError } from '../domain/errors.ts';
import {
  type FetchMode,
  newSourceId,
  Source,
  type SourceKind,
  type SourceSettingsInput,
  type SourceSnapshot,
  sourceSettings,
} from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';
import { previewCommandOf, type SourceChecker } from './check-source.ts';
import type { YouTubeChannels } from './ports.ts';
import { assertSupported } from './supported-sources.ts';
import { sourceUrlFor } from './youtube-videos.ts';

export interface CreateSourceCommand extends SourceSettingsInput {
  readonly ownerId: string;
  readonly name: string;
  readonly url: string;
  readonly kind: SourceKind;
  readonly fetchMode: FetchMode;
  readonly waitForSelector?: string | null;
  /** Save without trying the source first (e.g. a feed that is empty for now). */
  readonly skipCheck?: boolean;
}

export interface CreateSourceDeps {
  readonly repository: SourceRepository;
  readonly checker: SourceChecker;
  readonly channels: YouTubeChannels;
  readonly clock: Clock;
}

/** A saved source, with what its check found that did not stop it. */
export interface CheckedSource {
  readonly source: SourceSnapshot;
  readonly warnings: readonly string[];
}

/** Adds a source after trying it the way the collector will, so a broken one is refused. */
export class CreateSource {
  readonly #deps: CreateSourceDeps;

  constructor(deps: CreateSourceDeps) {
    this.#deps = deps;
  }

  async execute(command: CreateSourceCommand): Promise<CheckedSource> {
    const { repository, checker, channels, clock } = this.#deps;
    const source = Source.create({
      id: newSourceId(),
      ownerId: command.ownerId,
      name: command.name,
      url: await sourceUrlFor(channels, command.kind, command.url),
      fetchMode: command.fetchMode,
      waitForSelector: command.waitForSelector,
      settings: sourceSettings(command.kind, command),
      now: clock.now(),
    });
    assertSupported(source.kind, command.fetchMode);

    if (await repository.findActiveByUrl(command.ownerId, source.url)) {
      throw new DuplicateSourceError(source.url);
    }
    const snapshot = source.toSnapshot();
    const { warnings } = command.skipCheck
      ? { warnings: [] }
      : await checker.check(previewCommandOf(snapshot));
    await repository.save(source);
    return { source: snapshot, warnings };
  }
}
