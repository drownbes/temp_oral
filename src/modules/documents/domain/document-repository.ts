import type { Document, DocumentId } from './document.ts';

/** Port: persistence of the Document aggregate. */
export interface DocumentRepository {
  findById(id: DocumentId): Promise<Document | undefined>;
  save(document: Document): Promise<void>;
}
