import type { Clock } from '#shared/kernel/clock.ts';
import { DuplicateSourceError, SourceNotFoundError } from '../domain/errors.ts';
import {
  type FetchMode,
  type SourceId,
  type SourceKind,
  type SourceSettingsInput,
  type SourceSnapshot,
  sourceSettings,
} from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';
import { assertSupported } from './supported-sources.ts';

export interface UpdateSourceCommand extends SourceSettingsInput {
  readonly name?: string;
  readonly url?: string;
  readonly kind?: SourceKind;
  readonly fetchMode?: FetchMode;
  readonly enabled?: boolean;
}

export interface UpdateSourceDeps {
  readonly repository: SourceRepository;
  readonly clock: Clock;
}

const SETTINGS_FIELDS = ['fetchArticles', 'linkSelector', 'urlPattern', 'contentSelector'] as const;

export class UpdateSource {
  readonly #deps: UpdateSourceDeps;

  constructor(deps: UpdateSourceDeps) {
    this.#deps = deps;
  }

  async execute(id: SourceId, command: UpdateSourceCommand): Promise<SourceSnapshot> {
    const { repository, clock } = this.#deps;
    const source = await repository.findById(id);
    if (!source || source.isArchived) throw new SourceNotFoundError(id);

    // Settings are replaced as a whole: omitted options keep their current value
    const current = source.toSnapshot();
    const touchesSettings =
      command.kind !== undefined || SETTINGS_FIELDS.some((f) => command[f] !== undefined);
    const options: Record<string, unknown> = { ...current.settings };
    for (const field of SETTINGS_FIELDS) {
      if (command[field] !== undefined) options[field] = command[field];
    }
    const settings = touchesSettings
      ? sourceSettings(command.kind ?? source.kind, options as SourceSettingsInput)
      : undefined;

    source.update(
      {
        name: command.name,
        url: command.url,
        fetchMode: command.fetchMode,
        enabled: command.enabled,
        settings,
      },
      clock.now(),
    );
    const updated = source.toSnapshot();
    assertSupported(source.kind, updated.fetchMode);

    if (updated.url !== current.url) {
      const other = await repository.findActiveByUrl(updated.ownerId, updated.url);
      if (other && other.id !== id) throw new DuplicateSourceError(updated.url);
    }
    await repository.save(source);
    return updated;
  }
}
