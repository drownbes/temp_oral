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
import { assertSupported } from './supported-sources.ts';

export interface CreateSourceCommand extends SourceSettingsInput {
  readonly ownerId: string;
  readonly name: string;
  readonly url: string;
  readonly kind: SourceKind;
  readonly fetchMode: FetchMode;
  readonly waitForSelector?: string | null;
}

export interface CreateSourceDeps {
  readonly repository: SourceRepository;
  readonly clock: Clock;
}

export class CreateSource {
  readonly #deps: CreateSourceDeps;

  constructor(deps: CreateSourceDeps) {
    this.#deps = deps;
  }

  async execute(command: CreateSourceCommand): Promise<SourceSnapshot> {
    const { repository, clock } = this.#deps;
    const source = Source.create({
      id: newSourceId(),
      ownerId: command.ownerId,
      name: command.name,
      url: command.url,
      fetchMode: command.fetchMode,
      waitForSelector: command.waitForSelector,
      settings: sourceSettings(command.kind, command),
      now: clock.now(),
    });
    assertSupported(source.kind, command.fetchMode);

    if (await repository.findActiveByUrl(command.ownerId, source.url)) {
      throw new DuplicateSourceError(source.url);
    }
    await repository.save(source);
    return source.toSnapshot();
  }
}
