import type { Clock } from '#shared/kernel/clock.ts';
import type { Document, DocumentId } from '../domain/document.ts';
import type { DocumentRepository } from '../domain/document-repository.ts';
import { DocumentNotFoundError } from '../domain/errors.ts';
import type { DocumentContentStore } from './ports.ts';

export interface ProcessedDocument {
  readonly documentId: DocumentId;
  readonly filename: string;
  readonly uploadedBy: string;
  readonly checksum: string;
}

export interface ProcessDocumentDeps {
  readonly repository: DocumentRepository;
  readonly contentStore: DocumentContentStore;
  readonly clock: Clock;
}

/**
 * Computes the content checksum and marks the document processed.
 * Idempotent, because it runs as a Temporal activity and may be retried.
 */
export class ProcessDocument {
  readonly #deps: ProcessDocumentDeps;

  constructor(deps: ProcessDocumentDeps) {
    this.#deps = deps;
  }

  async execute(id: DocumentId): Promise<ProcessedDocument> {
    const { repository, contentStore, clock } = this.#deps;
    const document = await repository.findById(id);
    if (!document) throw new DocumentNotFoundError(id);
    if (document.status === 'processed') return toResult(document);

    // A previous attempt may have crashed after marking it processing
    if (document.status !== 'processing') {
      document.startProcessing(clock.now());
      await repository.save(document);
    }

    const checksum = await sha256Hex(await contentStore.get(id));
    document.completeProcessing(checksum, clock.now());
    await repository.save(document);
    return toResult(document);
  }
}

function toResult(document: Document): ProcessedDocument {
  const { id, filename, uploadedBy, checksum } = document.toSnapshot();
  return { documentId: id, filename, uploadedBy, checksum: checksum ?? '' };
}

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', content as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
