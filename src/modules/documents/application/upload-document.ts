import type { Clock } from '#shared/kernel/clock.ts';
import { Document, type DocumentSnapshot, newDocumentId } from '../domain/document.ts';
import type { DocumentRepository } from '../domain/document-repository.ts';
import type { DocumentContentStore, DocumentProcessingScheduler } from './ports.ts';

export interface UploadDocumentCommand {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly uploadedBy: string;
}

export interface UploadDocumentDeps {
  readonly repository: DocumentRepository;
  readonly contentStore: DocumentContentStore;
  readonly scheduler: DocumentProcessingScheduler;
  readonly clock: Clock;
}

export class UploadDocument {
  readonly #deps: UploadDocumentDeps;

  constructor(deps: UploadDocumentDeps) {
    this.#deps = deps;
  }

  async execute(command: UploadDocumentCommand): Promise<DocumentSnapshot> {
    const { repository, contentStore, scheduler, clock } = this.#deps;
    const document = Document.upload({
      id: newDocumentId(),
      filename: command.filename,
      contentType: command.contentType,
      sizeBytes: command.content.byteLength,
      uploadedBy: command.uploadedBy,
      now: clock.now(),
    });

    // Content first: a stored row must always have its object. If scheduling fails the
    // document stays `uploaded` and can be rescheduled.
    await contentStore.put(document.id, command.content, document.toSnapshot().contentType);
    await repository.save(document);
    await scheduler.schedule(document.id);

    return document.toSnapshot();
  }
}
