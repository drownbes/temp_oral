import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ArchiveSource } from '../../application/archive-source.ts';
import type { CreateSource } from '../../application/create-source.ts';
import type { GetSource } from '../../application/get-source.ts';
import type { ListSourceItems } from '../../application/list-source-items.ts';
import type { ListSources } from '../../application/list-sources.ts';
import type { PreviewSource, SourcePreview } from '../../application/preview-source.ts';
import type { StartCollection } from '../../application/start-collection.ts';
import type { UpdateSource } from '../../application/update-source.ts';
import type { ItemSnapshot } from '../../domain/item.ts';
import {
  FETCH_MODES,
  SOURCE_KINDS,
  type SourceId,
  type SourceSnapshot,
} from '../../domain/source.ts';

/** Single-user for now; becomes the authenticated user once the API has auth. */
const OWNER_ID = 'default';

const SourceParams = z.object({ id: z.uuid() });
const ItemsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const settingsFields = {
  fetchArticles: z.boolean().nullable().optional(),
  linkSelector: z.string().nullable().optional(),
  urlPattern: z.string().nullable().optional(),
  contentSelector: z.string().nullable().optional(),
};
const CreateSourceBody = z.object({
  name: z.string(),
  url: z.string(),
  kind: z.enum(SOURCE_KINDS).default('feed'),
  fetchMode: z.enum(FETCH_MODES).default('http'),
  ...settingsFields,
});
const UpdateSourceBody = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  kind: z.enum(SOURCE_KINDS).optional(),
  fetchMode: z.enum(FETCH_MODES).optional(),
  enabled: z.boolean().optional(),
  ...settingsFields,
});
const PreviewSourceBody = CreateSourceBody.omit({ name: true });
const StartCollectionBody = z.object({ runId: z.string() });

const iso = (date: Date | null) => date?.toISOString() ?? null;

const toSourceDto = (s: SourceSnapshot) => ({
  id: s.id,
  name: s.name,
  url: s.url,
  ...s.settings,
  fetchMode: s.fetchMode,
  enabled: s.enabled,
  lastCollectedAt: iso(s.lastCollectedAt),
  consecutiveFailures: s.consecutiveFailures,
  lastError: s.lastError,
  baselinedAt: iso(s.baselinedAt),
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

const toItemDto = (i: ItemSnapshot) => ({
  id: i.id,
  kind: i.kind,
  url: i.url,
  title: i.title,
  publishedAt: iso(i.publishedAt),
  discoveredAt: i.discoveredAt.toISOString(),
  baseline: i.baseline,
  exportedInRun: i.exportedInRun,
});

const toPreviewDto = (p: SourcePreview) => ({
  ...p,
  entries: p.entries.map((e) => ({ ...e, publishedAt: iso(e.publishedAt) })),
});

export function sourceRoutes(useCases: {
  create: CreateSource;
  update: UpdateSource;
  archive: ArchiveSource;
  get: GetSource;
  list: ListSources;
  listItems: ListSourceItems;
  preview: PreviewSource;
  startCollection: StartCollection;
}): FastifyPluginAsync {
  // Named so @fastify/otel spans read "handler - sourcesHttp" instead of the source text
  return async function sourcesHttp(app) {
    app.post('/sources', async (request, reply) => {
      const body = CreateSourceBody.parse(request.body);
      const source = await useCases.create.execute({ ...body, ownerId: OWNER_ID });
      return reply
        .status(201)
        .header('location', `/sources/${source.id}`)
        .send(toSourceDto(source));
    });

    app.get('/sources', async () => {
      const sources = await useCases.list.execute(OWNER_ID);
      return sources.map(toSourceDto);
    });

    // Dry run: fetch and extract without storing anything, to check URL and settings
    app.post('/sources/preview', async (request) => {
      const body = PreviewSourceBody.parse(request.body);
      return toPreviewDto(await useCases.preview.execute(body));
    });

    // Manual collection run; the daily digest starts runs itself
    app.post('/sources/collect', async (request, reply) => {
      const { runId } = StartCollectionBody.parse(request.body);
      return reply.status(202).send(await useCases.startCollection.execute(runId));
    });

    app.get('/sources/:id', async (request) => {
      const { id } = SourceParams.parse(request.params);
      return toSourceDto(await useCases.get.execute(id as SourceId));
    });

    app.patch('/sources/:id', async (request) => {
      const { id } = SourceParams.parse(request.params);
      const body = UpdateSourceBody.parse(request.body);
      return toSourceDto(await useCases.update.execute(id as SourceId, body));
    });

    app.delete('/sources/:id', async (request, reply) => {
      const { id } = SourceParams.parse(request.params);
      await useCases.archive.execute(id as SourceId);
      return reply.status(204).send();
    });

    app.get('/sources/:id/items', async (request) => {
      const { id } = SourceParams.parse(request.params);
      const { limit } = ItemsQuery.parse(request.query);
      const items = await useCases.listItems.execute(id as SourceId, limit);
      return items.map(toItemDto);
    });
  };
}
