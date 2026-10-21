import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type {
  GetInterestProfile,
  UpdateInterestProfile,
} from '../../application/interest-profile.ts';
import type { StartDigestRun } from '../../application/start-digest-run.ts';
import type { GetDigest, ListDigests } from '../../application/view-digests.ts';
import type { DigestId, DigestSnapshot } from '../../domain/digest.ts';
import type { DigestEntry } from '../../domain/digest-entry.ts';
import type { InterestProfileSnapshot } from '../../domain/interest-profile.ts';

const DigestParams = z.object({ id: z.uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
const ProfileBody = z.object({
  interests: z.string().optional(),
  relevanceThreshold: z.number().optional(),
});
const StartRunBody = z.object({ runId: z.string().optional() }).default({});

const iso = (date: Date | null) => date?.toISOString() ?? null;

const toDigestDto = (d: DigestSnapshot) => ({
  id: d.id,
  runId: d.runId,
  status: d.status,
  itemCount: d.itemCount,
  analyzedCount: d.analyzedCount,
  failedItemCount: d.failedItemCount,
  failedSources: d.failedSources,
  batchRef: d.batchRef,
  usage: d.usage,
  failureReason: d.failureReason,
  publishedAt: iso(d.publishedAt),
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

const toEntryDto = (e: DigestEntry) => ({
  itemId: e.itemId,
  sourceName: e.sourceName,
  url: e.url,
  title: e.title,
  publishedAt: iso(e.publishedAt),
  analysis: e.analysis,
  failure: e.failure,
});

const toProfileDto = (p: InterestProfileSnapshot) => ({
  interests: p.interests,
  relevanceThreshold: p.relevanceThreshold,
  updatedAt: p.updatedAt.toISOString(),
});

export function digestRoutes(
  ownerId: string,
  useCases: {
    getProfile: GetInterestProfile;
    updateProfile: UpdateInterestProfile;
    listDigests: ListDigests;
    getDigest: GetDigest;
    startRun: StartDigestRun;
  },
): FastifyPluginAsync {
  // Named so @fastify/otel spans read "handler - digestsHttp" instead of the source text
  return async function digestsHttp(app) {
    app.get('/profile', async () => toProfileDto(await useCases.getProfile.execute(ownerId)));

    app.put('/profile', async (request) => {
      const body = ProfileBody.parse(request.body);
      return toProfileDto(await useCases.updateProfile.execute(ownerId, body));
    });

    app.get('/digests', async (request) => {
      const { limit } = ListQuery.parse(request.query);
      return (await useCases.listDigests.execute(ownerId, limit)).map(toDigestDto);
    });

    app.get('/digests/:id', async (request) => {
      const { id } = DigestParams.parse(request.params);
      const { digest, entries } = await useCases.getDigest.execute(id as DigestId);
      return { ...toDigestDto(digest), entries: entries.map(toEntryDto) };
    });

    // Manual run (today by default); the daily schedule starts runs on its own
    app.post('/digests/runs', async (request, reply) => {
      const { runId } = StartRunBody.parse(request.body ?? {});
      return reply.status(202).send(await useCases.startRun.execute(ownerId, runId));
    });
  };
}
