import type { Kysely, Selectable } from 'kysely';
import { Notification, type NotificationId } from '../../domain/notification.ts';
import type { NotificationRepository } from '../../domain/notification-repository.ts';
import type { NotificationsTables, NotificationTable } from './tables.ts';

export class KyselyNotificationRepository implements NotificationRepository {
  readonly #db: Kysely<NotificationsTables>;

  constructor(db: Kysely<NotificationsTables>) {
    this.#db = db;
  }

  async findByIdempotencyKey(key: string): Promise<Notification | undefined> {
    const row = await this.#db
      .selectFrom('notifications.notification')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    return row && toDomain(row);
  }

  async listByRecipient(recipient: string, limit: number): Promise<Notification[]> {
    const rows = await this.#db
      .selectFrom('notifications.notification')
      .selectAll()
      .where('recipient', '=', recipient)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toDomain);
  }

  async save(notification: Notification): Promise<void> {
    const s = notification.toSnapshot();
    await this.#db
      .insertInto('notifications.notification')
      .values({
        id: s.id,
        idempotency_key: s.idempotencyKey,
        recipient: s.recipient,
        subject: s.subject,
        body: s.body,
        status: s.status,
        created_at: s.createdAt,
        sent_at: s.sentAt,
      })
      .onConflict((oc) => oc.column('id').doUpdateSet({ status: s.status, sent_at: s.sentAt }))
      .execute();
  }
}

function toDomain(row: Selectable<NotificationTable>): Notification {
  return Notification.restore({
    id: row.id as NotificationId,
    idempotencyKey: row.idempotency_key,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  });
}
