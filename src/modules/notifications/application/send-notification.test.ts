import { describe, expect, it } from 'vitest';
import { InvalidNotificationError } from '../domain/errors.ts';
import { SendNotification } from './send-notification.ts';
import { InMemoryNotificationRepository, RecordingSender } from './testing/fakes.ts';

const clock = { now: () => new Date('2026-01-01T00:00:00Z') };
const command = {
  idempotencyKey: 'k-1',
  recipient: 'ada@example.com',
  subject: 'Hello',
  body: 'World',
};

describe('SendNotification', () => {
  it('delivers once per idempotency key', async () => {
    const repository = new InMemoryNotificationRepository();
    const sender = new RecordingSender();
    const useCase = new SendNotification({ repository, sender, clock });

    const first = await useCase.execute(command);
    const second = await useCase.execute(command);

    expect(second.notificationId).toBe(first.notificationId);
    expect(sender.sent).toEqual([
      { recipient: 'ada@example.com', subject: 'Hello', body: 'World' },
    ]);
    expect(repository.rows.get(first.notificationId)?.status).toBe('sent');
  });

  it('retries delivery of a recorded but unsent notification', async () => {
    const repository = new InMemoryNotificationRepository();
    const failing = {
      send: async () => {
        throw new Error('smtp down');
      },
    };
    await expect(
      new SendNotification({ repository, sender: failing, clock }).execute(command),
    ).rejects.toThrow('smtp down');

    const sender = new RecordingSender();
    await new SendNotification({ repository, sender, clock }).execute(command);
    expect(sender.sent).toHaveLength(1);
    expect(repository.rows.size).toBe(1);
  });

  it('rejects invalid recipients', async () => {
    const useCase = new SendNotification({
      repository: new InMemoryNotificationRepository(),
      sender: new RecordingSender(),
      clock,
    });
    await expect(useCase.execute({ ...command, recipient: 'nope' })).rejects.toThrow(
      InvalidNotificationError,
    );
  });
});
