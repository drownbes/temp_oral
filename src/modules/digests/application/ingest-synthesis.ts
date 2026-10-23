import type { Clock } from '#shared/kernel/clock.ts';
import { type DigestId, NO_USAGE } from '../domain/digest.ts';
import { DigestNotFoundError, InvalidDigestStateError } from '../domain/errors.ts';
import type { DigestRepository } from '../domain/repositories.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { DigestSynthesizer } from './ports.ts';

export interface IngestSynthesisDeps {
  readonly digests: DigestRepository;
  readonly synthesizer: DigestSynthesizer;
  readonly clock: Clock;
}

/**
 * Applies merged headlines and the overview. Synthesis is polish, so a failed batch does
 * not fail the digest: stories keep their lead item's headline and the page has no overview.
 */
export class IngestSynthesis {
  readonly #deps: IngestSynthesisDeps;

  constructor(deps: IngestSynthesisDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, synthesizer, clock } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, synthesisBatchRef } = digest.toSnapshot();
    if (status !== 'synthesizing') return toState(digest);
    if (!synthesisBatchRef) {
      throw new InvalidDigestStateError(`digest ${digestId} has no synthesis batch to ingest`);
    }

    const batch = await synthesizer.status(synthesisBatchRef);
    if (batch.state === 'pending') {
      throw new InvalidDigestStateError(`synthesis of digest ${digestId} is still running`);
    }
    const results =
      batch.state === 'failed'
        ? { stories: new Map(), overview: null, usage: NO_USAGE }
        : await synthesizer.results(synthesisBatchRef);

    digest.completeSynthesis(results, clock.now());
    await digests.save(digest);
    return toState(digest);
  }
}
