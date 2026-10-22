/**
 * Idempotency key of an LLM batch: the digest, the step and a hash of what is being asked.
 * A retried submit with the same input finds the batch it already paid for; a restarted
 * digest that collected different items gets a new batch instead of stale results.
 */
export async function batchKey(digestId: string, step: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 6);
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return `digest-${digestId}-${step}-${hash}`;
}
