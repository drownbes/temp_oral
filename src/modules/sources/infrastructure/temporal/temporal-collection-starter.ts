import type { Client } from '@temporalio/client';
import type { CollectionStarter } from '../../application/ports.ts';
import {
  COLLECT_SOURCES_WORKFLOW,
  type CollectSourcesWorkflow,
  SOURCES_TASK_QUEUE,
} from '../../contracts/index.ts';
import type { RunId } from '../../domain/run-id.ts';
import { collectSourcesWorkflowId } from '../../interface/temporal/definitions.ts';

export class TemporalCollectionStarter implements CollectionStarter {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async start(runId: RunId): Promise<{ workflowId: string }> {
    // Deterministic id: starting a run that is already in progress joins it
    const handle = await this.#client.workflow.start<CollectSourcesWorkflow>(
      COLLECT_SOURCES_WORKFLOW,
      {
        taskQueue: SOURCES_TASK_QUEUE,
        workflowId: collectSourcesWorkflowId(runId),
        workflowIdConflictPolicy: 'USE_EXISTING',
        args: [{ runId }],
      },
    );
    return { workflowId: handle.workflowId };
  }
}
