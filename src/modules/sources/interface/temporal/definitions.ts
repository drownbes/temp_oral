/** Temporal wiring internal to the sources context; the public part is in contracts/. */

/** How many sources one run fetches at the same time. */
export const COLLECT_CONCURRENCY = 4;

export const collectSourcesWorkflowId = (runId: string) => `collect-sources-${runId}`;
