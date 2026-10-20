import type { NotificationSnapshot } from '../domain/notification.ts';
import type { NotificationRepository } from '../domain/notification-repository.ts';

export class ListNotifications {
  readonly #repository: NotificationRepository;

  constructor(repository: NotificationRepository) {
    this.#repository = repository;
  }

  async execute(recipient: string, limit = 50): Promise<NotificationSnapshot[]> {
    const notifications = await this.#repository.listByRecipient(recipient, limit);
    return notifications.map((n) => n.toSnapshot());
  }
}
