import { parseRunId } from '../domain/run-id.ts';
import type { FetchMode, SourceId } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';

export interface CollectableSource {
  readonly sourceId: SourceId;
  /** Browser sources are collected by the worker that runs Chromium. */
  readonly fetchMode: FetchMode;
}

/**
 * First step of a run: validates the run id (so a bad one fails the run up front instead of
 * every source) and lists the sources to collect.
 */
export class ListCollectableSources {
  readonly #repository: SourceRepository;

  constructor(repository: SourceRepository) {
    this.#repository = repository;
  }

  async execute(rawRunId: string): Promise<CollectableSource[]> {
    parseRunId(rawRunId);
    const sources = await this.#repository.listCollectable();
    return sources.map((s) => ({ sourceId: s.id, fetchMode: s.fetchMode }));
  }
}
