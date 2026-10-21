import { failOnDomainError } from '#shared/infrastructure/temporal/errors.ts';
import type { CollectSource, CollectSourceResult } from '../../application/collect-source.ts';
import type { ExportItems, ExportItemsResult } from '../../application/export-items.ts';
import type { ListCollectableSources } from '../../application/list-collectable-sources.ts';
import type { RecordCollectionFailure } from '../../application/record-collection-failure.ts';
import type { SourceId } from '../../domain/source.ts';

/** Inbound adapter: Temporal activities are thin wrappers that call use cases. */
export function createSourceActivities(useCases: {
  listCollectableSources: ListCollectableSources;
  collectSource: CollectSource;
  recordCollectionFailure: RecordCollectionFailure;
  exportItems: ExportItems;
}) {
  return {
    listCollectableSources(runId: string): Promise<string[]> {
      return failOnDomainError(() => useCases.listCollectableSources.execute(runId));
    },
    collectSource(sourceId: string, runId: string): Promise<CollectSourceResult> {
      return failOnDomainError(() => useCases.collectSource.execute(sourceId as SourceId, runId));
    },
    recordCollectionFailure(sourceId: string, reason: string): Promise<void> {
      return failOnDomainError(() =>
        useCases.recordCollectionFailure.execute(sourceId as SourceId, reason),
      );
    },
    exportItems(runId: string): Promise<ExportItemsResult> {
      return failOnDomainError(() => useCases.exportItems.execute(runId));
    },
  };
}

export type SourceActivities = ReturnType<typeof createSourceActivities>;
