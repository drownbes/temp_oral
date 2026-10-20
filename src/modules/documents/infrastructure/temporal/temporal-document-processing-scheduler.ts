import type { Client } from '@temporalio/client';
import type { DocumentProcessingScheduler } from '../../application/ports.ts';
import type { DocumentId } from '../../domain/document.ts';
import {
  DOCUMENTS_TASK_QUEUE,
  PROCESS_DOCUMENT_WORKFLOW,
  processDocumentWorkflowId,
} from '../../interface/temporal/definitions.ts';
import type { processDocumentWorkflow } from '../../interface/temporal/workflows.ts';

export class TemporalDocumentProcessingScheduler implements DocumentProcessingScheduler {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async schedule(id: DocumentId): Promise<void> {
    // Deterministic workflow id: scheduling the same document twice while it runs is rejected
    await this.#client.workflow.start<typeof processDocumentWorkflow>(PROCESS_DOCUMENT_WORKFLOW, {
      taskQueue: DOCUMENTS_TASK_QUEUE,
      workflowId: processDocumentWorkflowId(id),
      args: [{ documentId: id }],
    });
  }
}
