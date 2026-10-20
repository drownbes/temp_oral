import type { DocumentId, DocumentSnapshot } from '../domain/document.ts';
import type { DocumentRepository } from '../domain/document-repository.ts';
import { DocumentNotFoundError } from '../domain/errors.ts';

export class GetDocument {
  readonly #repository: DocumentRepository;

  constructor(repository: DocumentRepository) {
    this.#repository = repository;
  }

  async execute(id: DocumentId): Promise<DocumentSnapshot> {
    const document = await this.#repository.findById(id);
    if (!document) throw new DocumentNotFoundError(id);
    return document.toSnapshot();
  }
}
