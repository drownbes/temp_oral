import { ConflictError, NotFoundError, ValidationError } from '#shared/kernel/errors.ts';

export class SourceNotFoundError extends NotFoundError {
  readonly code = 'SOURCE_NOT_FOUND';

  constructor(id: string) {
    super(`Source ${id} not found`);
  }
}

export class InvalidSourceError extends ValidationError {
  readonly code = 'INVALID_SOURCE';
}

/** The source is valid but this deployment cannot collect it yet (e.g. browser fetching). */
export class SourceKindNotSupportedError extends ValidationError {
  readonly code = 'SOURCE_KIND_NOT_SUPPORTED';
}

export class DuplicateSourceError extends ConflictError {
  readonly code = 'DUPLICATE_SOURCE';

  constructor(url: string) {
    super(`A source for ${url} already exists`);
  }
}

export class ArchivedSourceError extends ConflictError {
  readonly code = 'SOURCE_ARCHIVED';

  constructor(id: string) {
    super(`Source ${id} is archived`);
  }
}

/** Reading the source showed it cannot work as configured: refused, empty, nothing matches. */
export class UnusableSourceError extends ValidationError {
  readonly code = 'SOURCE_UNUSABLE';
}

/** The fetched content is not a feed we can read; retrying will not help. */
export class InvalidFeedError extends ValidationError {
  readonly code = 'INVALID_FEED';
}

/** The source URL cannot be fetched for a reason retrying will not fix (4xx, blocked, too big). */
export class SourceFetchError extends ValidationError {
  readonly code = 'SOURCE_FETCH_FAILED';
}

export class InvalidRunIdError extends ValidationError {
  readonly code = 'INVALID_RUN_ID';
}
