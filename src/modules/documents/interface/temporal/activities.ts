import { failOnDomainError } from '#shared/infrastructure/temporal/errors.ts';
import type { MarkDocumentFailed } from '../../application/mark-document-failed.ts';
import type { ProcessDocument, ProcessedDocument } from '../../application/process-document.ts';
import type { DocumentId } from '../../domain/document.ts';

/** Inbound adapter: Temporal activities are thin wrappers that call use cases. */
export function createDocumentActivities(useCases: {
  processDocument: ProcessDocument;
  markDocumentFailed: MarkDocumentFailed;
}) {
  return {
    processDocument(documentId: string): Promise<ProcessedDocument> {
      return failOnDomainError(() => useCases.processDocument.execute(documentId as DocumentId));
    },
    markDocumentFailed(documentId: string, reason: string): Promise<void> {
      return failOnDomainError(() =>
        useCases.markDocumentFailed.execute(documentId as DocumentId, reason),
      );
    },
  };
}

export type DocumentActivities = ReturnType<typeof createDocumentActivities>;
