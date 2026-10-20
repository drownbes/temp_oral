import type { DocumentId } from '../domain/document.ts';

/** Port: binary content of documents (S3 in production). */
export interface DocumentContentStore {
  put(id: DocumentId, content: Uint8Array, contentType: string): Promise<void>;
  get(id: DocumentId): Promise<Uint8Array>;
}

/** Port: kicks off asynchronous processing (a Temporal workflow in production). */
export interface DocumentProcessingScheduler {
  schedule(id: DocumentId): Promise<void>;
}
