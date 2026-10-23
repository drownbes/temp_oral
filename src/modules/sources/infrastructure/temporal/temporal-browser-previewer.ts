import { ApplicationFailure, type Client, WorkflowFailedError } from '@temporalio/client';
import type {
  BrowserPreviewer,
  PreviewSourceCommand,
  SourcePreview,
} from '../../application/preview-source.ts';
import { SOURCES_TASK_QUEUE } from '../../contracts/index.ts';
import {
  InvalidFeedError,
  InvalidSourceError,
  SourceFetchError,
  SourceKindNotSupportedError,
} from '../../domain/errors.ts';
import {
  BROWSER_UNAVAILABLE,
  PREVIEW_SOURCE_WORKFLOW,
} from '../../interface/temporal/definitions.ts';

/** Failure types the preview can end with, back to the errors the HTTP layer maps. */
const ERRORS: Record<string, new (message: string) => Error> = {
  [BROWSER_UNAVAILABLE]: SourceKindNotSupportedError,
  SOURCE_FETCH_FAILED: SourceFetchError,
  INVALID_FEED: InvalidFeedError,
  INVALID_SOURCE: InvalidSourceError,
};

/** Runs a browser preview on the browser worker and waits for it (seconds). */
export class TemporalBrowserPreviewer implements BrowserPreviewer {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async preview(command: PreviewSourceCommand): Promise<SourcePreview> {
    let preview: SourcePreview;
    try {
      preview = await this.#client.workflow.execute(PREVIEW_SOURCE_WORKFLOW, {
        taskQueue: SOURCES_TASK_QUEUE,
        workflowId: `preview-source-${crypto.randomUUID()}`,
        workflowExecutionTimeout: '3 minutes',
        args: [command],
      });
    } catch (err) {
      const cause = err instanceof WorkflowFailedError ? err.cause : undefined;
      const DomainError = cause instanceof ApplicationFailure && ERRORS[cause.type ?? ''];
      if (DomainError) throw new DomainError(cause.message);
      throw err;
    }
    // Dates arrive as strings from the workflow's JSON
    return {
      ...preview,
      entries: preview.entries.map((e) => ({
        ...e,
        publishedAt: e.publishedAt === null ? null : new Date(e.publishedAt),
      })),
    };
  }
}
