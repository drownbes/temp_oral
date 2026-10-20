import { failOnDomainError } from '#shared/infrastructure/temporal/errors.ts';
import type {
  SendNotification,
  SendNotificationCommand,
} from '../../application/send-notification.ts';
import type { SendNotificationResult } from '../../contracts/index.ts';

export function createNotificationActivities(useCases: { sendNotification: SendNotification }) {
  return {
    sendNotification(command: SendNotificationCommand): Promise<SendNotificationResult> {
      return failOnDomainError(() => useCases.sendNotification.execute(command));
    },
  };
}

export type NotificationActivities = ReturnType<typeof createNotificationActivities>;
