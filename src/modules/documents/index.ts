import { fileURLToPath } from 'node:url';
import type { ModuleDefinition, ModuleDeps } from '#shared/infrastructure/module.ts';
import { systemClock } from '#shared/kernel/clock.ts';
import { GetDocument } from './application/get-document.ts';
import { MarkDocumentFailed } from './application/mark-document-failed.ts';
import { ProcessDocument } from './application/process-document.ts';
import { UploadDocument } from './application/upload-document.ts';
import { KyselyDocumentRepository } from './infrastructure/persistence/kysely-document-repository.ts';
import { DOCUMENTS_SCHEMA, type DocumentsTables } from './infrastructure/persistence/tables.ts';
import { S3DocumentContentStore } from './infrastructure/storage/s3-document-content-store.ts';
import { TemporalDocumentProcessingScheduler } from './infrastructure/temporal/temporal-document-processing-scheduler.ts';
import { documentRoutes } from './interface/http/routes.ts';
import { createDocumentActivities } from './interface/temporal/activities.ts';
import { DOCUMENTS_TASK_QUEUE } from './interface/temporal/definitions.ts';

/** Composition of the documents context: binds its ports to adapters on shared infrastructure. */
function adapters(deps: ModuleDeps) {
  return {
    repository: new KyselyDocumentRepository(deps.db.withTables<DocumentsTables>()),
    contentStore: new S3DocumentContentStore(deps.s3, deps.config.s3.bucket),
    clock: systemClock,
  };
}

export const documentsModule: ModuleDefinition = {
  name: 'documents',
  migrations: {
    schema: DOCUMENTS_SCHEMA,
    folder: fileURLToPath(new URL('./infrastructure/persistence/migrations', import.meta.url)),
  },
  http(deps) {
    const { repository, contentStore, clock } = adapters(deps);
    const scheduler = new TemporalDocumentProcessingScheduler(deps.temporal);
    return documentRoutes({
      upload: new UploadDocument({ repository, contentStore, scheduler, clock }),
      get: new GetDocument(repository),
    });
  },
  worker(deps) {
    const { repository, contentStore, clock } = adapters(deps);
    return {
      taskQueue: DOCUMENTS_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./interface/temporal/workflows.ts', import.meta.url)),
      activities: createDocumentActivities({
        processDocument: new ProcessDocument({ repository, contentStore, clock }),
        markDocumentFailed: new MarkDocumentFailed({ repository, clock }),
      }),
    };
  },
};
