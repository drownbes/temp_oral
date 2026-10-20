/**
 * Base class for errors that carry business meaning. Adapters translate them
 * (HTTP status codes, non-retryable Temporal failures) by `code`, never by message.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The requested aggregate does not exist. */
export abstract class NotFoundError extends DomainError {}

/** Input violates a domain invariant. */
export abstract class ValidationError extends DomainError {}

/** The operation is not allowed in the aggregate's current state. */
export abstract class ConflictError extends DomainError {}
