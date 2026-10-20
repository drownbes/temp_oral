import type { Logger } from './logger.ts';

type Closer = { name: string; close: () => Promise<unknown> };

/**
 * Collects resources in startup order and closes them in reverse on SIGINT/SIGTERM,
 * so e.g. the HTTP server stops before the DB pool it depends on.
 */
export class Lifecycle {
  readonly #closers: Closer[] = [];
  readonly #logger: Logger;
  #closing: Promise<void> | undefined;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  onShutdown(name: string, close: () => Promise<unknown>): void {
    this.#closers.push({ name, close });
  }

  handleSignals(signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): void {
    for (const signal of signals) {
      process.once(signal, () => {
        this.#logger.info({ signal }, 'shutdown requested');
        void this.shutdown().then(() => process.exit(process.exitCode ?? 0));
      });
    }
  }

  shutdown(): Promise<void> {
    this.#closing ??= this.#closeAll();
    return this.#closing;
  }

  async #closeAll(): Promise<void> {
    for (const { name, close } of this.#closers.toReversed()) {
      try {
        await close();
        this.#logger.debug({ resource: name }, 'closed');
      } catch (err) {
        process.exitCode = 1;
        this.#logger.error({ err, resource: name }, 'failed to close');
      }
    }
  }
}
