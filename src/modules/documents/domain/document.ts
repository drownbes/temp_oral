import type { Brand } from '#shared/kernel/brand.ts';
import { InvalidDocumentError, InvalidDocumentStateError } from './errors.ts';

export type DocumentId = Brand<string, 'DocumentId'>;

export const newDocumentId = (): DocumentId => crypto.randomUUID() as DocumentId;

export type DocumentStatus = 'uploaded' | 'processing' | 'processed' | 'failed';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export interface DocumentSnapshot {
  readonly id: DocumentId;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadedBy: string;
  readonly status: DocumentStatus;
  /** sha256 of the content, known once processed. */
  readonly checksum: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UploadDocumentProps {
  readonly id: DocumentId;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadedBy: string;
  readonly now: Date;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Aggregate root. State changes only through methods that enforce the lifecycle. */
export class Document {
  #state: DocumentSnapshot;

  private constructor(state: DocumentSnapshot) {
    this.#state = state;
  }

  static upload(props: UploadDocumentProps): Document {
    const filename = props.filename.trim();
    if (!filename) throw new InvalidDocumentError('filename is required');
    if (filename.length > 255) throw new InvalidDocumentError('filename is too long');
    if (props.sizeBytes <= 0) throw new InvalidDocumentError('document is empty');
    if (props.sizeBytes > MAX_DOCUMENT_BYTES) {
      throw new InvalidDocumentError(`document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    }
    if (!EMAIL.test(props.uploadedBy))
      throw new InvalidDocumentError('uploadedBy must be an email');

    return new Document({
      id: props.id,
      filename,
      contentType: props.contentType || 'application/octet-stream',
      sizeBytes: props.sizeBytes,
      uploadedBy: props.uploadedBy,
      status: 'uploaded',
      checksum: null,
      failureReason: null,
      createdAt: props.now,
      updatedAt: props.now,
    });
  }

  /** Rehydrates from persistence; no invariants re-checked. */
  static restore(snapshot: DocumentSnapshot): Document {
    return new Document(snapshot);
  }

  get id(): DocumentId {
    return this.#state.id;
  }

  get status(): DocumentStatus {
    return this.#state.status;
  }

  startProcessing(now: Date): void {
    if (this.#state.status !== 'uploaded' && this.#state.status !== 'failed') {
      throw new InvalidDocumentStateError(
        `cannot process a document that is ${this.#state.status}`,
      );
    }
    this.#state = { ...this.#state, status: 'processing', failureReason: null, updatedAt: now };
  }

  completeProcessing(checksum: string, now: Date): void {
    if (this.#state.status !== 'processing') {
      throw new InvalidDocumentStateError(
        `cannot complete a document that is ${this.#state.status}`,
      );
    }
    this.#state = { ...this.#state, status: 'processed', checksum, updatedAt: now };
  }

  fail(reason: string, now: Date): void {
    if (this.#state.status === 'processed') {
      throw new InvalidDocumentStateError('cannot fail a processed document');
    }
    this.#state = { ...this.#state, status: 'failed', failureReason: reason, updatedAt: now };
  }

  toSnapshot(): DocumentSnapshot {
    return this.#state;
  }
}
