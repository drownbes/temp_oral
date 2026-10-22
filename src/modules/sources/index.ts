import { fileURLToPath } from 'node:url';
import type { ModuleDefinition, ModuleDeps } from '#shared/infrastructure/module.ts';
import { systemClock } from '#shared/kernel/clock.ts';
import { ArchiveSource } from './application/archive-source.ts';
import { CollectSource } from './application/collect-source.ts';
import { CreateSource } from './application/create-source.ts';
import { ExportItems } from './application/export-items.ts';
import { GetSource } from './application/get-source.ts';
import { ListCollectableSources } from './application/list-collectable-sources.ts';
import { ListSourceItems } from './application/list-source-items.ts';
import { ListSources } from './application/list-sources.ts';
import { PreviewSource } from './application/preview-source.ts';
import { RecordCollectionFailure } from './application/record-collection-failure.ts';
import { StartCollection } from './application/start-collection.ts';
import { UpdateSource } from './application/update-source.ts';
import { SOURCES_TASK_QUEUE } from './contracts/index.ts';
import { FeedsmithFeedReader } from './infrastructure/extract/feedsmith-feed-reader.ts';
import { ReadabilityArticleExtractor } from './infrastructure/extract/readability-article-extractor.ts';
import { UndiciPageFetcher } from './infrastructure/fetch/undici-page-fetcher.ts';
import { KyselyItemRepository } from './infrastructure/persistence/kysely-item-repository.ts';
import { KyselySourceRepository } from './infrastructure/persistence/kysely-source-repository.ts';
import { SOURCES_SCHEMA, type SourcesTables } from './infrastructure/persistence/tables.ts';
import { S3ItemContentStore } from './infrastructure/storage/s3-item-content-store.ts';
import { S3ItemExporter } from './infrastructure/storage/s3-item-exporter.ts';
import { TemporalCollectionStarter } from './infrastructure/temporal/temporal-collection-starter.ts';
import { sourceRoutes } from './interface/http/routes.ts';
import { createSourceActivities } from './interface/temporal/activities.ts';

/** Composition of the sources context: binds its ports to adapters on shared infrastructure. */
function adapters(deps: ModuleDeps) {
  const db = deps.db.withTables<SourcesTables>();
  return {
    sources: new KyselySourceRepository(db),
    items: new KyselyItemRepository(db),
    fetcher: new UndiciPageFetcher(deps.config.fetch),
    feedReader: new FeedsmithFeedReader(),
    articleExtractor: new ReadabilityArticleExtractor(),
    clock: systemClock,
  };
}

export const sourcesModule: ModuleDefinition = {
  name: 'sources',
  migrations: {
    schema: SOURCES_SCHEMA,
    folder: fileURLToPath(new URL('./infrastructure/persistence/migrations', import.meta.url)),
  },
  http(deps) {
    const { sources, items, fetcher, feedReader, articleExtractor, clock } = adapters(deps);
    return sourceRoutes({
      create: new CreateSource({ repository: sources, clock }),
      update: new UpdateSource({ repository: sources, clock }),
      archive: new ArchiveSource({ repository: sources, clock }),
      get: new GetSource(sources),
      list: new ListSources(sources),
      listItems: new ListSourceItems({ sources, items }),
      preview: new PreviewSource({ fetcher, feedReader, articleExtractor }),
      startCollection: new StartCollection(new TemporalCollectionStarter(deps.temporal)),
    });
  },
  worker(deps) {
    const { sources, items, fetcher, feedReader, articleExtractor, clock } = adapters(deps);
    const contentStore = new S3ItemContentStore(deps.s3, deps.config.s3.bucket);
    const exporter = new S3ItemExporter(deps.s3, deps.config.s3.bucket);
    return {
      taskQueue: SOURCES_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./interface/temporal/workflows.ts', import.meta.url)),
      activities: createSourceActivities({
        listCollectableSources: new ListCollectableSources(sources),
        collectSource: new CollectSource({
          sources,
          items,
          fetcher,
          feedReader,
          articleExtractor,
          contentStore,
          clock,
        }),
        recordCollectionFailure: new RecordCollectionFailure({ repository: sources, clock }),
        exportItems: new ExportItems({ items, sources, contentStore, exporter }),
      }),
    };
  },
};
