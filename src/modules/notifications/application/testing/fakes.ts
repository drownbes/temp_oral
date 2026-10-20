import { Notification, type NotificationSnapshot } from '../../domain/notification.ts';
import type { NotificationRepository } from '../../domain/notification-repository.ts';
import type { NotificationSender } from '../ports.ts';

export class InMemoryNotificationRepository implements NotificationRepository {
  readonly rows = new Map<string, NotificationSnapshot>();

  async findByIdempotencyKey(key: string): Promise<Notification | undefined> {
    const row = [...this.rows.values()].find((r) => r.idempotencyKey === key);
    return row && Notification.restore(row);
  }

  async listByRecipient(recipient: string, limit: number): Promise<Notification[]> {
    return [...this.rows.values()]
      .filter((r) => r.recipient === recipient)
      .slice(0, limit)
      .map((r) => Notification.restore(r));
  }

  async save(notification: Notification): Promise<void> {
    this.rows.set(notification.id, notification.toSnapshot());
  }
}

export class RecordingSender implements NotificationSender {
  readonly sent: Parameters<NotificationSender['send']>[0][] = [];

  async send(message: Parameters<NotificationSender['send']>[0]): Promise<void> {
    this.sent.push(message);
  }
}
