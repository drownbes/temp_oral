import { fileURLToPath } from 'node:url';
import type {
  ModuleDefinition,
  ModuleDeps,
  WorkerDefinition,
} from '#shared/infrastructure/module.ts';
import { systemClock } from '#shared/kernel/clock.ts';
import { ArchiveSource } from './application/archive-source.ts';
import { CollectSource } from './application/collect-source.ts';
import { CreateSource } from './application/create-source.ts';
import { ExportItems } from './application/export-items.ts';
import { GetSource } from './application/get-source.ts';
import { ListCollectableSources } from './application/list-collectable-sources.ts';
import { ListSourceItems } from './application/list-source-items.ts';
import { ListSources } from './application/list-sources.ts';
import type { PageFetcher } from './application/ports.ts';
import { PreviewSource } from './application/preview-source.ts';
import { RecordCollectionFailure } from './application/record-collection-failure.ts';
import { StartCollection } from './application/start-collection.ts';
import { UpdateSource } from './application/update-source.ts';
import { SOURCES_TASK_QUEUE } from './contracts/index.ts';
import { FeedsmithFeedReader } from './infrastructure/extract/feedsmith-feed-reader.ts';
import { LinkedomLinkExtractor } from './infrastructure/extract/linkedom-link-extractor.ts';
import { LinkedomPageTextExtractor } from './infrastructure/extract/linkedom-page-text-extractor.ts';
import { ReadabilityArticleExtractor } from './infrastructure/extract/readability-article-extractor.ts';
import { PlaywrightPageFetcher } from './infrastructure/fetch/playwright-page-fetcher.ts';
import { UndiciPageFetcher } from './infrastructure/fetch/undici-page-fetcher.ts';
import { KyselyItemRepository } from './infrastructure/persistence/kysely-item-repository.ts';
import { KyselyPageSnapshotRepository } from './infrastructure/persistence/kysely-page-snapshot-repository.ts';
import { KyselySourceRepository } from './infrastructure/persistence/kysely-source-repository.ts';
import { SOURCES_SCHEMA, type SourcesTables } from './infrastructure/persistence/tables.ts';
import { S3ItemContentStore } from './infrastructure/storage/s3-item-content-store.ts';
import { S3ItemExporter } from './infrastructure/storage/s3-item-exporter.ts';
import { TemporalBrowserPreviewer } from './infrastructure/temporal/temporal-browser-previewer.ts';
import { TemporalCollectionStarter } from './infrastructure/temporal/temporal-collection-starter.ts';
import { sourceRoutes } from './interface/http/routes.ts';
import {
  createBrowserActivities,
  createSourceActivities,
} from './interface/temporal/activities.ts';
import { SOURCES_BROWSER_TASK_QUEUE } from './interface/temporal/definitions.ts';

/** Composition of the sources context: binds its ports to adapters on shared infrastructure. */
function adapters(deps: ModuleDeps) {
  const db = deps.db.withTables<SourcesTables>();
  return {
    sources: new KyselySourceRepository(db),
    items: new KyselyItemRepository(db),
    fetcher: new UndiciPageFetcher(deps.config.fetch),
    extractors: {
      feedReader: new FeedsmithFeedReader(),
      linkExtractor: new LinkedomLinkExtractor(),
      articleExtractor: new ReadabilityArticleExtractor(),
      pageTextExtractor: new LinkedomPageTextExtractor(),
    },
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
    const { sources, items, fetcher, extractors, clock } = adapters(deps);
    return sourceRoutes({
      create: new CreateSource({ repository: sources, clock }),
      update: new UpdateSource({ repository: sources, clock }),
      archive: new ArchiveSource({ repository: sources, clock }),
      get: new GetSource(sources),
      list: new ListSources(sources),
      listItems: new ListSourceItems({ sources, items }),
      // The API has no browser: browser previews run on the browser worker
      preview: new PreviewSource({
        fetcher,
        ...extractors,
        browserPreviewer: new TemporalBrowserPreviewer(deps.temporal),
      }),
      startCollection: new StartCollection(new TemporalCollectionStarter(deps.temporal)),
    });
  },
  worker(deps) {
    const { sources, items, fetcher, extractors, clock } = adapters(deps);
    const db = deps.db.withTables<SourcesTables>();
    const contentStore = new S3ItemContentStore(deps.s3, deps.config.s3.bucket);
    const collectSource = (pageFetcher: PageFetcher) =>
      new CollectSource({
        sources,
        items,
        snapshots: new KyselyPageSnapshotRepository(db),
        fetcher: pageFetcher,
        ...extractors,
        contentStore,
        clock,
      });

    const workers: WorkerDefinition[] = [
      {
        taskQueue: SOURCES_TASK_QUEUE,
        workflowsPath: fileURLToPath(new URL('./interface/temporal/workflows.ts', import.meta.url)),
        activities: createSourceActivities({
          listCollectableSources: new ListCollectableSources(sources),
          collectSource: collectSource(fetcher),
          recordCollectionFailure: new RecordCollectionFailure({ repository: sources, clock }),
          exportItems: new ExportItems({
            items,
            sources,
            contentStore,
            exporter: new S3ItemExporter(deps.s3, deps.config.s3.bucket),
          }),
        }),
      },
    ];

    // Only here is Chromium needed, and only once a browser source is collected
    if (deps.config.browser.enabled) {
      const browserFetcher = new PlaywrightPageFetcher({
        executablePath: deps.config.browser.executablePath,
        timeoutMs: deps.config.browser.timeoutMs,
        maxBytes: deps.config.fetch.maxBytes,
        allowPrivateNetworks: deps.config.fetch.allowPrivateNetworks,
      });
      deps.onShutdown('browser', () => browserFetcher.close());
      workers.push({
        taskQueue: SOURCES_BROWSER_TASK_QUEUE,
        activities: createBrowserActivities({
          collectSource: collectSource(browserFetcher),
          previewSource: new PreviewSource({ fetcher: browserFetcher, ...extractors }),
        }),
        maxConcurrentActivities: deps.config.browser.concurrency,
      });
    }
    return workers;
  },
};
