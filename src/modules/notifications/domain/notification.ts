import type { Brand } from '#shared/kernel/brand.ts';
import { InvalidNotificationError, NotificationAlreadySentError } from './errors.ts';

export type NotificationId = Brand<string, 'NotificationId'>;

export const newNotificationId = (): NotificationId => crypto.randomUUID() as NotificationId;

export type NotificationStatus = 'pending' | 'sent';

export interface NotificationSnapshot {
  readonly id: NotificationId;
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly status: NotificationStatus;
  readonly createdAt: Date;
  readonly sentAt: Date | null;
}

export interface CreateNotificationProps {
  readonly id: NotificationId;
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly now: Date;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Notification {
  #state: NotificationSnapshot;

  private constructor(state: NotificationSnapshot) {
    this.#state = state;
  }

  static create(props: CreateNotificationProps): Notification {
    if (!props.idempotencyKey) throw new InvalidNotificationError('idempotencyKey is required');
    if (!EMAIL.test(props.recipient))
      throw new InvalidNotificationError('recipient must be an email');
    if (!props.subject.trim()) throw new InvalidNotificationError('subject is required');

    return new Notification({
      id: props.id,
      idempotencyKey: props.idempotencyKey,
      recipient: props.recipient,
      subject: props.subject.trim(),
      body: props.body,
      status: 'pending',
      createdAt: props.now,
      sentAt: null,
    });
  }

  static restore(snapshot: NotificationSnapshot): Notification {
    return new Notification(snapshot);
  }

  get id(): NotificationId {
    return this.#state.id;
  }

  get isSent(): boolean {
    return this.#state.status === 'sent';
  }

  markSent(now: Date): void {
    if (this.isSent) throw new NotificationAlreadySentError(`notification ${this.id} already sent`);
    this.#state = { ...this.#state, status: 'sent', sentAt: now };
  }

  toSnapshot(): NotificationSnapshot {
    return this.#state;
  }
}
