import type { PageSnapshot } from './page-watch.ts';
import type { Source, SourceId } from './source.ts';

/** Port: persistence of the Source aggregate. Archived sources are kept but never listed. */
export interface SourceRepository {
  findById(id: SourceId): Promise<Source | undefined>;
  findByIds(ids: readonly SourceId[]): Promise<Source[]>;
  /** The non-archived source of `ownerId` with this canonical URL, if any. */
  findActiveByUrl(ownerId: string, url: string): Promise<Source | undefined>;
  listActive(ownerId: string): Promise<Source[]>;
  /** Enabled, non-archived sources of every owner. */
  listCollectable(): Promise<Source[]>;
  /** Throws DuplicateSourceError when another active source of the owner has the same URL. */
  save(source: Source): Promise<void>;
}

/** Port: the last seen version of each watched page. */
export interface PageSnapshotRepository {
  find(sourceId: SourceId): Promise<PageSnapshot | undefined>;
  save(snapshot: PageSnapshot): Promise<void>;
}
