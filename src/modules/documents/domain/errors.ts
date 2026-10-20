import { ConflictError, NotFoundError, ValidationError } from '#shared/kernel/errors.ts';

export class DocumentNotFoundError extends NotFoundError {
  readonly code = 'DOCUMENT_NOT_FOUND';

  constructor(id: string) {
    super(`Document ${id} not found`);
  }
}

export class InvalidDocumentError extends ValidationError {
  readonly code = 'INVALID_DOCUMENT';
}

export class InvalidDocumentStateError extends ConflictError {
  readonly code = 'INVALID_DOCUMENT_STATE';
}
