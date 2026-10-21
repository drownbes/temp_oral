import type { DigestId, DigestSnapshot } from '../domain/digest.ts';
import type { DigestEntry } from '../domain/digest-entry.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import type { DigestEntryRepository, DigestRepository } from '../domain/repositories.ts';

export interface DigestWithEntries {
  readonly digest: DigestSnapshot;
  readonly entries: readonly DigestEntry[];
}

export class GetDigest {
  readonly #deps: { readonly digests: DigestRepository; readonly entries: DigestEntryRepository };

  constructor(deps: { digests: DigestRepository; entries: DigestEntryRepository }) {
    this.#deps = deps;
  }

  async execute(id: DigestId): Promise<DigestWithEntries> {
    const digest = await this.#deps.digests.findById(id);
    if (!digest) throw new DigestNotFoundError(id);
    return { digest: digest.toSnapshot(), entries: await this.#deps.entries.listByDigest(id) };
  }
}

export class ListDigests {
  readonly #digests: DigestRepository;

  constructor(digests: DigestRepository) {
    this.#digests = digests;
  }

  async execute(ownerId: string, limit: number): Promise<DigestSnapshot[]> {
    return (await this.#digests.listRecent(ownerId, limit)).map((d) => d.toSnapshot());
  }
}
