import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '#shared/infrastructure/db/database.ts';
import { createLogger } from '#shared/infrastructure/logger.ts';
import { integrationConfig } from '#test/integration-env.ts';
import { Notification, newNotificationId } from '../../domain/notification.ts';
import { KyselyNotificationRepository } from './kysely-notification-repository.ts';
import type { NotificationsTables } from './tables.ts';

describe('KyselyNotificationRepository', () => {
  let db: Database;
  let repository: KyselyNotificationRepository;

  beforeAll(() => {
    const config = integrationConfig();
    db = createDatabase(config, createLogger(config, 'test'));
    repository = new KyselyNotificationRepository(db.withTables<NotificationsTables>());
  });

  afterAll(() => db.destroy());

  const create = (recipient: string, key = crypto.randomUUID(), now = new Date()) =>
    Notification.create({
      id: newNotificationId(),
      idempotencyKey: key,
      recipient,
      subject: 'Hi',
      body: 'Body',
      now,
    });

  it('finds by idempotency key and persists sending', async () => {
    const notification = create('ada@example.com');
    await repository.save(notification);
    notification.markSent(new Date());
    await repository.save(notification);

    const found = await repository.findByIdempotencyKey(notification.toSnapshot().idempotencyKey);
    expect(found?.isSent).toBe(true);
  });

  it('enforces one notification per idempotency key', async () => {
    const key = crypto.randomUUID();
    await repository.save(create('ada@example.com', key));
    await expect(repository.save(create('ada@example.com', key))).rejects.toThrow();
  });

  it('lists by recipient, newest first', async () => {
    const recipient = `${crypto.randomUUID()}@example.com`;
    const older = create(recipient, undefined, new Date('2026-01-01T00:00:00Z'));
    await repository.save(older);
    const newer = create(recipient, undefined, new Date('2026-01-02T00:00:00Z'));
    await repository.save(newer);

    const ids = (await repository.listByRecipient(recipient, 10)).map((n) => n.id);
    expect(ids).toEqual([newer.id, older.id]);
  });
});
