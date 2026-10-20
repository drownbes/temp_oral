import { ApplicationFailure } from '@temporalio/common';
import { DomainError } from '../../kernel/errors.ts';

/**
 * Domain errors will not go away on retry, so activities surface them as non-retryable
 * failures with the error code as the failure type. Anything else is retried by Temporal.
 */
export async function failOnDomainError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DomainError) {
      throw ApplicationFailure.create({
        type: err.code,
        message: err.message,
        nonRetryable: true,
        cause: err,
      });
    }
    throw err;
  }
}
