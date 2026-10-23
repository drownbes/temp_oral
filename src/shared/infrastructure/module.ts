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
  /** Registers a resource a module created itself (e.g. a browser) to close on shutdown. */
  readonly onShutdown: (name: string, close: () => Promise<unknown>) => void;
}

export interface WorkerDefinition {
  readonly taskQueue: string;
  /**
   * Absolute path of the module exporting the workflow functions (bundled by Temporal).
   * Omitted for an activity-only queue.
   */
  readonly workflowsPath?: string;
  readonly activities: object;
  /** Activities running at once on this queue (e.g. browser pages); Temporal's default if unset. */
  readonly maxConcurrentActivities?: number;
}

/** What a bounded context exposes to the composition root. Everything else stays internal. */
export interface ModuleDefinition {
  readonly name: string;
  readonly migrations: ModuleMigrations;
  readonly http?: (deps: ModuleDeps) => FastifyPluginAsync;
  /** One worker per task queue; a module may serve several (e.g. a browser-only queue). */
  readonly worker?: (deps: ModuleDeps) => WorkerDefinition | readonly WorkerDefinition[];
  /** Temporal Schedules this module needs; the worker creates or updates them at startup. */
  readonly schedules?: (deps: ModuleDeps) => readonly ScheduleDefinition[];
}
