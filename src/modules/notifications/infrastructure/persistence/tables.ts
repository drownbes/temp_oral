import type { NotificationStatus } from '../../domain/notification.ts';

export const NOTIFICATIONS_SCHEMA = 'notifications';

export type NotificationTable = {
  id: string;
  idempotency_key: string;
  recipient: string;
  subject: string;
  body: string;
  status: NotificationStatus;
  created_at: Date;
  sent_at: Date | null;
};

export type NotificationsTables = {
  'notifications.notification': NotificationTable;
};
