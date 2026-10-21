import { ConflictError, NotFoundError, ValidationError } from '#shared/kernel/errors.ts';

export class DigestNotFoundError extends NotFoundError {
  readonly code = 'DIGEST_NOT_FOUND';

  constructor(id: string) {
    super(`Digest ${id} not found`);
  }
}

export class InvalidDigestStateError extends ConflictError {
  readonly code = 'INVALID_DIGEST_STATE';
}

export class InvalidProfileError extends ValidationError {
  readonly code = 'INVALID_PROFILE';
}

export class InvalidRunIdError extends ValidationError {
  readonly code = 'INVALID_RUN_ID';
}

/** The LLM batch as a whole was rejected (bad model, bad request file); retrying won't help. */
export class EnrichmentFailedError extends ValidationError {
  readonly code = 'ENRICHMENT_FAILED';
}
