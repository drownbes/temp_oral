import type { Brand } from '#shared/kernel/brand.ts';
import { InvalidDigestStateError } from './errors.ts';
import type { RunId } from './run-id.ts';

export type DigestId = Brand<string, 'DigestId'>;

export const newDigestId = (): DigestId => crypto.randomUUID() as DigestId;

/**
 * collecting → enriching → rendering → published
 *            ↘ (nothing new) ↗        ↘ superseded (a newer day already published)
 * Any unfinished state → failed; a failed digest can be restarted.
 */
export type DigestStatus =
  | 'collecting'
  | 'enriching'
  | 'rendering'
  | 'published'
  | 'superseded'
  | 'failed';

export interface FailedSource {
  readonly sourceId: string;
  readonly reason: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface DigestSnapshot {
  readonly id: DigestId;
  readonly ownerId: string;
  readonly runId: RunId;
  readonly status: DigestStatus;
  /** Claim check of the collected items (sources contract). */
  readonly exportKey: string | null;
  readonly itemCount: number;
  readonly failedSources: readonly FailedSource[];
  /** The LLM batch that analyses the items, once submitted. */
  readonly batchRef: string | null;
  readonly analyzedCount: number;
  readonly failedItemCount: number;
  readonly usage: TokenUsage;
  readonly failureReason: string | null;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CollectionOutcome {
  readonly exportKey: string;
  readonly itemCount: number;
  readonly failedSources: readonly FailedSource[];
}

export interface EnrichmentOutcome {
  readonly analyzedCount: number;
  readonly failedItemCount: number;
  readonly usage: TokenUsage;
}

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };
const MAX_REASON_LENGTH = 2000;

/** Aggregate root: one day's digest for one reader, from collection to the published page. */
export class Digest {
  #state: DigestSnapshot;

  private constructor(state: DigestSnapshot) {
    this.#state = state;
  }

  static begin(props: { id: DigestId; ownerId: string; runId: RunId; now: Date }): Digest {
    return new Digest({
      id: props.id,
      ownerId: props.ownerId,
      runId: props.runId,
      ...Digest.#fresh(),
      createdAt: props.now,
      updatedAt: props.now,
    });
  }

  static restore(snapshot: DigestSnapshot): Digest {
    return new Digest(snapshot);
  }

  static #fresh() {
    return {
      status: 'collecting' as const,
      exportKey: null,
      itemCount: 0,
      failedSources: [],
      batchRef: null,
      analyzedCount: 0,
      failedItemCount: 0,
      usage: NO_USAGE,
      failureReason: null,
      publishedAt: null,
    };
  }

  get id(): DigestId {
    return this.#state.id;
  }

  get status(): DigestStatus {
    return this.#state.status;
  }

  get isFinished(): boolean {
    return this.#state.status === 'published' || this.#state.status === 'superseded';
  }

  /** Runs a failed digest again from the start; collection and export are idempotent. */
  restart(now: Date): void {
    this.#expect('failed', 'restart');
    this.#state = { ...this.#state, ...Digest.#fresh(), updatedAt: now };
  }

  recordCollection(outcome: CollectionOutcome, now: Date): void {
    this.#expect('collecting', 'record the collection of');
    this.#state = {
      ...this.#state,
      ...outcome,
      // Nothing new: skip the LLM and publish an "all quiet" page
      status: outcome.itemCount > 0 ? 'enriching' : 'rendering',
      updatedAt: now,
    };
  }

  enrichmentSubmitted(batchRef: string, now: Date): void {
    this.#expect('enriching', 'submit enrichment for');
    if (this.#state.batchRef) {
      throw new InvalidDigestStateError(
        `digest ${this.id} already has batch ${this.#state.batchRef}`,
      );
    }
    this.#state = { ...this.#state, batchRef, updatedAt: now };
  }

  completeEnrichment(outcome: EnrichmentOutcome, now: Date): void {
    this.#expect('enriching', 'complete enrichment of');
    if (!this.#state.batchRef) {
      throw new InvalidDigestStateError(`digest ${this.id} has no enrichment batch yet`);
    }
    this.#state = { ...this.#state, ...outcome, status: 'rendering', updatedAt: now };
  }

  publish(now: Date): void {
    this.#expect('rendering', 'publish');
    this.#state = { ...this.#state, status: 'published', publishedAt: now, updatedAt: now };
  }

  /** A newer day's digest is already on the page; this one must not overwrite it. */
  supersede(now: Date): void {
    this.#expect('rendering', 'supersede');
    this.#state = { ...this.#state, status: 'superseded', updatedAt: now };
  }

  fail(reason: string, now: Date): void {
    if (this.isFinished) {
      throw new InvalidDigestStateError(`cannot fail digest ${this.id}: it is ${this.status}`);
    }
    this.#state = {
      ...this.#state,
      status: 'failed',
      failureReason: reason.slice(0, MAX_REASON_LENGTH),
      updatedAt: now,
    };
  }

  toSnapshot(): DigestSnapshot {
    return this.#state;
  }

  #expect(status: DigestStatus, action: string): void {
    if (this.#state.status !== status) {
      throw new InvalidDigestStateError(
        `cannot ${action} digest ${this.id}: it is ${this.#state.status}`,
      );
    }
  }
}
