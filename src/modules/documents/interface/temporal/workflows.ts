// Runs in Temporal's deterministic sandbox: import only @temporalio/workflow, contracts
// and types. dependency-cruiser enforces this.

import { executeChild, log, ParentClosePolicy, proxyActivities } from '@temporalio/workflow';
import {
  NOTIFICATIONS_TASK_QUEUE,
  SEND_NOTIFICATION_WORKFLOW,
  type SendNotificationWorkflow,
} from '#modules/notifications/contracts/index.ts';
import type { DocumentActivities } from './activities.ts';
import type { ProcessDocumentWorkflowInput } from './definitions.ts';

const { processDocument, markDocumentFailed } = proxyActivities<DocumentActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

export async function processDocumentWorkflow({
  documentId,
}: ProcessDocumentWorkflowInput): Promise<void> {
  let processed: Awaited<ReturnType<typeof processDocument>>;
  try {
    processed = await processDocument(documentId);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const reason = cause instanceof Error ? cause.message : String(cause);
    log.warn('document processing failed', { documentId, reason });
    await markDocumentFailed(documentId, reason);
    throw err;
  }

  // Cross-context call through the notifications contract, on its own task queue
  await executeChild<SendNotificationWorkflow>(SEND_NOTIFICATION_WORKFLOW, {
    taskQueue: NOTIFICATIONS_TASK_QUEUE,
    workflowId: `notify-document-processed-${documentId}`,
    parentClosePolicy: ParentClosePolicy.ABANDON,
    args: [
      {
        idempotencyKey: `document-processed:${documentId}`,
        recipient: processed.uploadedBy,
        subject: `Your document "${processed.filename}" is ready`,
        body: `Processed successfully. sha256: ${processed.checksum}`,
      },
    ],
  });
  log.info('document processed', { documentId });
}
