import type { Clock } from '#shared/kernel/clock.ts';
import type { DocumentId } from '../domain/document.ts';
import type { DocumentRepository } from '../domain/document-repository.ts';
import { DocumentNotFoundError } from '../domain/errors.ts';

export interface MarkDocumentFailedDeps {
  readonly repository: DocumentRepository;
  readonly clock: Clock;
}

export class MarkDocumentFailed {
  readonly #deps: MarkDocumentFailedDeps;

  constructor(deps: MarkDocumentFailedDeps) {
    this.#deps = deps;
  }

  async execute(id: DocumentId, reason: string): Promise<void> {
    const document = await this.#deps.repository.findById(id);
    if (!document) throw new DocumentNotFoundError(id);
    if (document.status === 'failed') return;
    document.fail(reason, this.#deps.clock.now());
    await this.#deps.repository.save(document);
  }
}
