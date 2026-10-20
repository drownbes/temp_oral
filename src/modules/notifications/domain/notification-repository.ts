import type { Notification } from './notification.ts';

export interface NotificationRepository {
  findByIdempotencyKey(key: string): Promise<Notification | undefined>;
  listByRecipient(recipient: string, limit: number): Promise<Notification[]>;
  save(notification: Notification): Promise<void>;
}
