import type { Client } from '@temporalio/client';
import type { DigestRunStarter } from '../../application/ports.ts';
import type { RunId } from '../../domain/run-id.ts';
import {
  DAILY_DIGEST_WORKFLOW,
  DIGESTS_TASK_QUEUE,
  digestWorkflowId,
} from '../../interface/temporal/definitions.ts';
import type { dailyDigestWorkflow } from '../../interface/temporal/workflows.ts';

export class TemporalDigestRunStarter implements DigestRunStarter {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async start(ownerId: string, runId: RunId): Promise<{ workflowId: string }> {
    // Deterministic id: triggering a day that is already running joins that run
    const handle = await this.#client.workflow.start<typeof dailyDigestWorkflow>(
      DAILY_DIGEST_WORKFLOW,
      {
        taskQueue: DIGESTS_TASK_QUEUE,
        workflowId: digestWorkflowId(ownerId, runId),
        workflowIdConflictPolicy: 'USE_EXISTING',
        args: [{ ownerId, runId }],
      },
    );
    return { workflowId: handle.workflowId };
  }
}
