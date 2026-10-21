import type { Digest, DigestId } from './digest.ts';
import type { DigestEntry } from './digest-entry.ts';
import type { InterestProfile } from './interest-profile.ts';
import type { RunId } from './run-id.ts';

/** Port: persistence of the Digest aggregate. */
export interface DigestRepository {
  findById(id: DigestId): Promise<Digest | undefined>;
  findByRun(ownerId: string, runId: RunId): Promise<Digest | undefined>;
  /** Newest run first. */
  listRecent(ownerId: string, limit: number): Promise<Digest[]>;
  /** The run id of the owner's most recently published (by run date) digest. */
  latestPublishedRunId(ownerId: string): Promise<RunId | undefined>;
  save(digest: Digest): Promise<void>;
}

/** Port: the items of a digest. Saving an entry again replaces it. */
export interface DigestEntryRepository {
  saveAll(entries: readonly DigestEntry[]): Promise<void>;
  listByDigest(digestId: DigestId): Promise<DigestEntry[]>;
}

/** Port: one interest profile per owner. */
export interface InterestProfileRepository {
  find(ownerId: string): Promise<InterestProfile | undefined>;
  save(profile: InterestProfile): Promise<void>;
}
