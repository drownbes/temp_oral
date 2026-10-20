import { Document, type DocumentId } from '../../domain/document.ts';
import type { DocumentRepository } from '../../domain/document-repository.ts';
import type { DocumentContentStore, DocumentProcessingScheduler } from '../ports.ts';

/** In-memory adapters for testing use cases without infrastructure. */
export class InMemoryDocumentRepository implements DocumentRepository {
  readonly rows = new Map<DocumentId, ReturnType<Document['toSnapshot']>>();

  async findById(id: DocumentId): Promise<Document | undefined> {
    const row = this.rows.get(id);
    return row && Document.restore(row);
  }

  async save(document: Document): Promise<void> {
    this.rows.set(document.id, document.toSnapshot());
  }
}

export class InMemoryContentStore implements DocumentContentStore {
  readonly objects = new Map<DocumentId, Uint8Array>();

  async put(id: DocumentId, content: Uint8Array): Promise<void> {
    this.objects.set(id, content);
  }

  async get(id: DocumentId): Promise<Uint8Array> {
    const content = this.objects.get(id);
    if (!content) throw new Error(`no content for ${id}`);
    return content;
  }
}

export class RecordingScheduler implements DocumentProcessingScheduler {
  readonly scheduled: DocumentId[] = [];

  async schedule(id: DocumentId): Promise<void> {
    this.scheduled.push(id);
  }
}

export const fixedClock = (iso = '2026-01-01T00:00:00Z') => ({ now: () => new Date(iso) });
