import type { Logger } from '#shared/infrastructure/logger.ts';
import type { NotificationSender } from '../../application/ports.ts';

/** Development stand-in for a real email adapter: writes the message to the structured log. */
export class LogNotificationSender implements NotificationSender {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async send(message: { recipient: string; subject: string; body: string }): Promise<void> {
    this.#logger.info({ notification: message }, 'notification sent');
  }
}
