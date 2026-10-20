import type { Clock } from '#shared/kernel/clock.ts';
import { Notification, type NotificationId, newNotificationId } from '../domain/notification.ts';
import type { NotificationRepository } from '../domain/notification-repository.ts';
import type { NotificationSender } from './ports.ts';

export interface SendNotificationCommand {
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

export interface SendNotificationDeps {
  readonly repository: NotificationRepository;
  readonly sender: NotificationSender;
  readonly clock: Clock;
}

/** Records then delivers a notification; repeated calls with the same key deliver once. */
export class SendNotification {
  readonly #deps: SendNotificationDeps;

  constructor(deps: SendNotificationDeps) {
    this.#deps = deps;
  }

  async execute(command: SendNotificationCommand): Promise<{ notificationId: NotificationId }> {
    const { repository, sender, clock } = this.#deps;

    let notification = await repository.findByIdempotencyKey(command.idempotencyKey);
    if (!notification) {
      notification = Notification.create({ id: newNotificationId(), ...command, now: clock.now() });
      await repository.save(notification);
    }
    if (!notification.isSent) {
      const { recipient, subject, body } = notification.toSnapshot();
      await sender.send({ recipient, subject, body });
      notification.markSent(clock.now());
      await repository.save(notification);
    }
    return { notificationId: notification.id };
  }
}
