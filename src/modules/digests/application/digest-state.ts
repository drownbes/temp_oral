import type { Digest, DigestStatus } from '../domain/digest.ts';

/** What the workflow needs to decide its next step. */
export interface DigestState {
  readonly digestId: string;
  readonly runId: string;
  readonly status: DigestStatus;
}

export function toState(digest: Digest): DigestState {
  const { id, runId, status } = digest.toSnapshot();
  return { digestId: id, runId, status };
}
