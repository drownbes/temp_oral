import { ConflictError, ValidationError } from '#shared/kernel/errors.ts';

export class InvalidNotificationError extends ValidationError {
  readonly code = 'INVALID_NOTIFICATION';
}

export class NotificationAlreadySentError extends ConflictError {
  readonly code = 'NOTIFICATION_ALREADY_SENT';
}
