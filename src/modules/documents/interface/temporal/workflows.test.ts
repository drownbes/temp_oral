import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOTIFICATIONS_TASK_QUEUE,
  type SendNotificationInput,
} from '#modules/notifications/contracts/index.ts';
import type { ProcessedDocument } from '../../application/process-document.ts';
import type { DocumentActivities } from './activities.ts';
import { DOCUMENTS_TASK_QUEUE } from './definitions.ts';
import { processDocumentWorkflow } from './workflows.ts';

const workflowsPath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

describe('processDocumentWorkflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    // ERROR only: the failure-path test logs expected activity/workflow failures at WARN
    Runtime.install({ logger: new DefaultLogger('ERROR') });
    // Ephemeral server from the temporal CLI provided by the Nix devShell
    env = await TestWorkflowEnvironment.createLocal({
      server: {
        executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH ?? 'temporal' },
        log: { format: 'pretty', level: 'error' },
      },
    });
  });

  afterAll(() => env?.teardown());

  /** Runs the documents workflow with fake activities next to the real notifications workflow. */
  async function run(documentActivities: DocumentActivities) {
    const sent: SendNotificationInput[] = [];
    const [documentsWorker, notificationsWorker] = await Promise.all([
      Worker.create({
        connection: env.nativeConnection,
        taskQueue: DOCUMENTS_TASK_QUEUE,
        workflowsPath: workflowsPath('./workflows.ts'),
        activities: documentActivities,
      }),
      Worker.create({
        connection: env.nativeConnection,
        taskQueue: NOTIFICATIONS_TASK_QUEUE,
        workflowsPath: workflowsPath('../../../notifications/interface/temporal/workflows.ts'),
        activities: {
          async sendNotification(input: SendNotificationInput) {
            sent.push(input);
            return { notificationId: 'n-1' };
          },
        },
      }),
    ]);

    const execution = env.client.workflow.execute(processDocumentWorkflow, {
      taskQueue: DOCUMENTS_TASK_QUEUE,
      workflowId: `test-${crypto.randomUUID()}`,
      args: [{ documentId: 'doc-1' }],
    });
    const result = documentsWorker.runUntil(notificationsWorker.runUntil(execution));
    return { result, sent };
  }

  it('processes the document and notifies the uploader through the notifications contract', async () => {
    const processed: ProcessedDocument = {
      documentId: 'doc-1' as ProcessedDocument['documentId'],
      filename: 'report.pdf',
      uploadedBy: 'ada@example.com',
      checksum: 'abc',
    };
    const { result, sent } = await run({
      processDocument: async () => processed,
      markDocumentFailed: async () => {
        throw new Error('must not be called');
      },
    });

    await result;
    expect(sent).toEqual([
      {
        idempotencyKey: 'document-processed:doc-1',
        recipient: 'ada@example.com',
        subject: 'Your document "report.pdf" is ready',
        body: 'Processed successfully. sha256: abc',
      },
    ]);
  });

  it('marks the document failed and sends nothing when processing fails', async () => {
    const failed: [string, string][] = [];
    const { result, sent } = await run({
      processDocument: async () => {
        throw ApplicationFailure.nonRetryable('corrupt file', 'INVALID_DOCUMENT');
      },
      markDocumentFailed: async (id, reason) => {
        failed.push([id, reason]);
      },
    });

    await expect(result).rejects.toThrow('Workflow execution failed');
    expect(failed).toEqual([['doc-1', 'corrupt file']]);
    expect(sent).toEqual([]);
  });
});
