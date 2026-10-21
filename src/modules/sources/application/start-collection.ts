import { parseRunId } from '../domain/run-id.ts';
import type { CollectionStarter } from './ports.ts';

/** Manual trigger of a collection run; the daily digest starts runs on its own. */
export class StartCollection {
  readonly #starter: CollectionStarter;

  constructor(starter: CollectionStarter) {
    this.#starter = starter;
  }

  async execute(rawRunId: string): Promise<{ runId: string; workflowId: string }> {
    const runId = parseRunId(rawRunId);
    const { workflowId } = await this.#starter.start(runId);
    return { runId, workflowId };
  }
}
