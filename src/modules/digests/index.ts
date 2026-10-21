import { fileURLToPath } from 'node:url';
import type { ModuleDefinition, ModuleDeps } from '#shared/infrastructure/module.ts';
import { systemClock } from '#shared/kernel/clock.ts';
import { BeginDigest } from './application/begin-digest.ts';
import { CheckEnrichment } from './application/check-enrichment.ts';
import { IngestEnrichment } from './application/ingest-enrichment.ts';
import { GetInterestProfile, UpdateInterestProfile } from './application/interest-profile.ts';
import { MarkDigestFailed } from './application/mark-digest-failed.ts';
import type { ItemAnalyzer } from './application/ports.ts';
import { PublishDigest } from './application/publish-digest.ts';
import { RecordCollection } from './application/record-collection.ts';
import { StartDigestRun } from './application/start-digest-run.ts';
import { SubmitEnrichment } from './application/submit-enrichment.ts';
import { GetDigest, ListDigests } from './application/view-digests.ts';
import { OpenAiBatchClient } from './infrastructure/llm/openai-batch-client.ts';
import { OpenAiItemAnalyzer } from './infrastructure/llm/openai-item-analyzer.ts';
import { StubItemAnalyzer } from './infrastructure/llm/stub-item-analyzer.ts';
import { KyselyDigestEntryRepository } from './infrastructure/persistence/kysely-digest-entry-repository.ts';
import { KyselyDigestRepository } from './infrastructure/persistence/kysely-digest-repository.ts';
import { KyselyInterestProfileRepository } from './infrastructure/persistence/kysely-interest-profile-repository.ts';
import { DIGESTS_SCHEMA, type DigestsTables } from './infrastructure/persistence/tables.ts';
import { S3DigestPublisher } from './infrastructure/publishing/s3-digest-publisher.ts';
import { S3ExportedItemsReader } from './infrastructure/storage/s3-exported-items-reader.ts';
import { TemporalDigestRunStarter } from './infrastructure/temporal/temporal-digest-run-starter.ts';
import { digestRoutes } from './interface/http/routes.ts';
import { createDigestActivities } from './interface/temporal/activities.ts';
import {
  DAILY_DIGEST_SCHEDULE,
  DAILY_DIGEST_WORKFLOW,
  type DailyDigestInput,
  DIGESTS_TASK_QUEUE,
} from './interface/temporal/definitions.ts';

/** Single-user for now; becomes the authenticated user (and one schedule per user) later. */
const OWNER_ID = 'default';

/** Composition of the digests context: binds its ports to adapters on shared infrastructure. */
function adapters(deps: ModuleDeps) {
  const db = deps.db.withTables<DigestsTables>();
  return {
    digests: new KyselyDigestRepository(db),
    entries: new KyselyDigestEntryRepository(db),
    profiles: new KyselyInterestProfileRepository(db),
    clock: systemClock,
  };
}

function itemAnalyzer(deps: ModuleDeps): ItemAnalyzer {
  if (deps.config.llm.provider === 'stub') return new StubItemAnalyzer();
  if (!deps.openai) throw new Error('LLM_PROVIDER=openai but no OpenAI client was created');
  const { itemModel, reasoningEffort } = deps.config.llm;
  return new OpenAiItemAnalyzer(new OpenAiBatchClient(deps.openai), {
    model: itemModel,
    reasoningEffort,
  });
}

export const digestsModule: ModuleDefinition = {
  name: 'digests',
  migrations: {
    schema: DIGESTS_SCHEMA,
    folder: fileURLToPath(new URL('./infrastructure/persistence/migrations', import.meta.url)),
  },
  http(deps) {
    const { digests, entries, profiles, clock } = adapters(deps);
    return digestRoutes(OWNER_ID, {
      getProfile: new GetInterestProfile({ profiles, clock }),
      updateProfile: new UpdateInterestProfile({ profiles, clock }),
      listDigests: new ListDigests(digests),
      getDigest: new GetDigest({ digests, entries }),
      startRun: new StartDigestRun({
        starter: new TemporalDigestRunStarter(deps.temporal),
        clock,
        timezone: deps.config.digest.timezone,
      }),
    });
  },
  worker(deps) {
    const { digests, entries, profiles, clock } = adapters(deps);
    const { digest: config } = deps.config;
    // The export belongs to the shared bucket, whatever bucket the page is published to
    const reader = new S3ExportedItemsReader(deps.s3, deps.config.s3.bucket);
    const analyzer = itemAnalyzer(deps);
    const publisher = new S3DigestPublisher(deps.s3, {
      bucket: config.publishBucket,
      key: config.publishKey,
      timezone: config.timezone,
    });
    return {
      taskQueue: DIGESTS_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./interface/temporal/workflows.ts', import.meta.url)),
      activities: createDigestActivities({
        beginDigest: new BeginDigest({ digests, clock, timezone: config.timezone }),
        recordCollection: new RecordCollection({ digests, clock }),
        submitEnrichment: new SubmitEnrichment({
          digests,
          profiles,
          reader,
          analyzer,
          clock,
          maxItemChars: config.maxItemChars,
        }),
        checkEnrichment: new CheckEnrichment({ digests, analyzer }),
        ingestEnrichment: new IngestEnrichment({ digests, entries, reader, analyzer, clock }),
        publishDigest: new PublishDigest({ digests, entries, profiles, publisher, clock }),
        markDigestFailed: new MarkDigestFailed({ digests, clock }),
      }),
    };
  },
  schedules(deps) {
    const input: DailyDigestInput = { ownerId: OWNER_ID };
    return [
      {
        scheduleId: DAILY_DIGEST_SCHEDULE,
        cron: deps.config.digest.cron,
        timezone: deps.config.digest.timezone,
        workflowType: DAILY_DIGEST_WORKFLOW,
        taskQueue: DIGESTS_TASK_QUEUE,
        args: [input],
      },
    ];
  },
};
