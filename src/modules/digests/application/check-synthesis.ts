import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestRepository } from '../domain/repositories.ts';
import type { DigestSynthesizer } from './ports.ts';

export interface CheckSynthesisDeps {
  readonly digests: DigestRepository;
  readonly synthesizer: DigestSynthesizer;
}

/** Polled by the workflow between durable timers: is the synthesis batch finished? */
export class CheckSynthesis {
  readonly #deps: CheckSynthesisDeps;

  constructor(deps: CheckSynthesisDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<{ done: boolean }> {
    const digest = await this.#deps.digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const { status, synthesisBatchRef } = digest.toSnapshot();
    if (status !== 'synthesizing' || !synthesisBatchRef) return { done: true };
    const batch = await this.#deps.synthesizer.status(synthesisBatchRef);
    return { done: batch.state !== 'pending' };
  }
}
