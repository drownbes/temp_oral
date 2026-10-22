import { SourceKindNotSupportedError } from '../domain/errors.ts';
import type { FetchMode, SourceKind } from '../domain/source.ts';

/** What the collectors in this version can read. Grows as listing / page / browser land. */
const SUPPORTED_KINDS: readonly SourceKind[] = ['feed', 'listing', 'page'];
const SUPPORTED_FETCH_MODES: readonly FetchMode[] = ['http'];

export function assertSupported(kind: SourceKind, fetchMode: FetchMode): void {
  if (!SUPPORTED_KINDS.includes(kind)) {
    throw new SourceKindNotSupportedError(`"${kind}" sources are not supported yet`);
  }
  if (!SUPPORTED_FETCH_MODES.includes(fetchMode)) {
    throw new SourceKindNotSupportedError(`fetch mode "${fetchMode}" is not supported yet`);
  }
}
