import type { S3Client } from '@aws-sdk/client-s3';
import type { Client } from '@temporalio/client';
import type { FastifyPluginAsync } from 'fastify';
import type OpenAI from 'openai';
import type { AppConfig } from './config.ts';
import type { Database } from './db/database.ts';
import type { ModuleMigrations } from './db/migrations.ts';
import type { Logger } from './logger.ts';
import type { ScheduleDefinition } from './temporal/schedules.ts';

/** Shared technical infrastructure handed to every bounded context by the composition root. */
export interface ModuleDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: Database;
  readonly s3: S3Client;
  readonly temporal: Client;
  /** Present only when LLM_PROVIDER=openai. */
  readonly openai: OpenAI | undefined;
}

export interface WorkerDefinition {
  readonly taskQueue: string;
  /** Absolute path of the module exporting the workflow functions (bundled by Temporal). */
  readonly workflowsPath: string;
  readonly activities: object;
}

/** What a bounded context exposes to the composition root. Everything else stays internal. */
export interface ModuleDefinition {
  readonly name: string;
  readonly migrations: ModuleMigrations;
  readonly http?: (deps: ModuleDeps) => FastifyPluginAsync;
  readonly worker?: (deps: ModuleDeps) => WorkerDefinition;
  /** Temporal Schedules this module needs; the worker creates or updates them at startup. */
  readonly schedules?: (deps: ModuleDeps) => readonly ScheduleDefinition[];
}
