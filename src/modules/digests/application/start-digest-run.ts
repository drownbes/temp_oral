import type { Clock } from '#shared/kernel/clock.ts';
import { parseRunId, runIdAt } from '../domain/run-id.ts';
import type { DigestRunStarter } from './ports.ts';

export interface StartDigestRunDeps {
  readonly starter: DigestRunStarter;
  readonly clock: Clock;
  readonly timezone: string;
}

/** Manual trigger; without a run id it builds today's digest (in the digest time zone). */
export class StartDigestRun {
  readonly #deps: StartDigestRunDeps;

  constructor(deps: StartDigestRunDeps) {
    this.#deps = deps;
  }

  async execute(
    ownerId: string,
    rawRunId?: string,
  ): Promise<{ runId: string; workflowId: string }> {
    const { starter, clock, timezone } = this.#deps;
    const runId = rawRunId ? parseRunId(rawRunId) : runIdAt(clock.now(), timezone);
    const { workflowId } = await starter.start(ownerId, runId);
    return { runId, workflowId };
  }
}
