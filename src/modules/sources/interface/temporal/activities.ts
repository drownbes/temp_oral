import { failOnDomainError } from '#shared/infrastructure/temporal/errors.ts';
import type { CollectSource, CollectSourceResult } from '../../application/collect-source.ts';
import type { ExportItems, ExportItemsResult } from '../../application/export-items.ts';
import type {
  CollectableSource,
  ListCollectableSources,
} from '../../application/list-collectable-sources.ts';
import type {
  PreviewSource,
  PreviewSourceCommand,
  SourcePreview,
} from '../../application/preview-source.ts';
import type {
  RecordCollectionFailure,
  RecordedFailure,
} from '../../application/record-collection-failure.ts';
import type { SourceId } from '../../domain/source.ts';

/** Inbound adapter: Temporal activities are thin wrappers that call use cases. */
export function createSourceActivities(useCases: {
  listCollectableSources: ListCollectableSources;
  collectSource: CollectSource;
  recordCollectionFailure: RecordCollectionFailure;
  exportItems: ExportItems;
}) {
  return {
    listCollectableSources(runId: string): Promise<CollectableSource[]> {
      return failOnDomainError(() => useCases.listCollectableSources.execute(runId));
    },
    collectSource(sourceId: string, runId: string): Promise<CollectSourceResult> {
      return failOnDomainError(() => useCases.collectSource.execute(sourceId as SourceId, runId));
    },
    recordCollectionFailure(
      sourceId: string,
      reason: string,
      countsAgainstSource = true,
    ): Promise<RecordedFailure> {
      return failOnDomainError(() =>
        useCases.recordCollectionFailure.execute(sourceId as SourceId, reason, countsAgainstSource),
      );
    },
    exportItems(runId: string): Promise<ExportItemsResult> {
      return failOnDomainError(() => useCases.exportItems.execute(runId));
    },
  };
}

export type SourceActivities = ReturnType<typeof createSourceActivities>;

/**
 * Activities of the sources-browser queue: the same use cases, built on a browser fetcher.
 * Only workers with BROWSER_FETCH_ENABLED register them.
 */
export function createBrowserActivities(useCases: {
  collectSource: CollectSource;
  previewSource: PreviewSource;
}) {
  return {
    collectSource(sourceId: string, runId: string): Promise<CollectSourceResult> {
      return failOnDomainError(() => useCases.collectSource.execute(sourceId as SourceId, runId));
    },
    previewSource(command: PreviewSourceCommand): Promise<SourcePreview> {
      return failOnDomainError(() => useCases.previewSource.execute(command));
    },
  };
}

export type BrowserActivities = ReturnType<typeof createBrowserActivities>;
