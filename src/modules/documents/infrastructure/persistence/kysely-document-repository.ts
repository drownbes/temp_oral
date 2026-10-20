import type { Kysely, Selectable } from 'kysely';
import { Document, type DocumentId } from '../../domain/document.ts';
import type { DocumentRepository } from '../../domain/document-repository.ts';
import type { DocumentsTables, DocumentTable } from './tables.ts';

export class KyselyDocumentRepository implements DocumentRepository {
  readonly #db: Kysely<DocumentsTables>;

  constructor(db: Kysely<DocumentsTables>) {
    this.#db = db;
  }

  async findById(id: DocumentId): Promise<Document | undefined> {
    const row = await this.#db
      .selectFrom('documents.document')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toDomain(row);
  }

  async save(document: Document): Promise<void> {
    const { id, created_at, ...changes } = toRow(document);
    await this.#db
      .insertInto('documents.document')
      .values({ id, created_at, ...changes })
      .onConflict((oc) => oc.column('id').doUpdateSet(changes))
      .execute();
  }
}

function toDomain(row: Selectable<DocumentTable>): Document {
  return Document.restore({
    id: row.id as DocumentId,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by,
    status: row.status,
    checksum: row.checksum,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toRow(document: Document): DocumentTable {
  const s = document.toSnapshot();
  return {
    id: s.id,
    filename: s.filename,
    content_type: s.contentType,
    size_bytes: s.sizeBytes,
    uploaded_by: s.uploadedBy,
    status: s.status,
    checksum: s.checksum,
    failure_reason: s.failureReason,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}
