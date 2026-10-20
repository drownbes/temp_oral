/** Temporal wiring internal to the documents context (worker + scheduler adapter). */
export const DOCUMENTS_TASK_QUEUE = 'documents';
export const PROCESS_DOCUMENT_WORKFLOW = 'processDocumentWorkflow';

export interface ProcessDocumentWorkflowInput {
  readonly documentId: string;
}

export const processDocumentWorkflowId = (documentId: string) => `process-document-${documentId}`;
