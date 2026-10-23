import type { Kysely, Selectable } from 'kysely';
import { Digest, type DigestId } from '../../domain/digest.ts';
import type { DigestRepository } from '../../domain/repositories.ts';
import type { RunId } from '../../domain/run-id.ts';
import type { DigestsTables, DigestTable } from './tables.ts';

export class KyselyDigestRepository implements DigestRepository {
  readonly #db: Kysely<DigestsTables>;

  constructor(db: Kysely<DigestsTables>) {
    this.#db = db;
  }

  async findById(id: DigestId): Promise<Digest | undefined> {
    const row = await this.#db
      .selectFrom('digests.digest')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toDomain(row);
  }

  async findByRun(ownerId: string, runId: RunId): Promise<Digest | undefined> {
    const row = await this.#db
      .selectFrom('digests.digest')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return row && toDomain(row);
  }

  async listRecent(ownerId: string, limit: number): Promise<Digest[]> {
    const rows = await this.#db
      .selectFrom('digests.digest')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('run_id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toDomain);
  }

  async latestPublishedRunId(ownerId: string): Promise<RunId | undefined> {
    const row = await this.#db
      .selectFrom('digests.digest')
      .select('run_id')
      .where('owner_id', '=', ownerId)
      .where('status', '=', 'published')
      .orderBy('run_id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.run_id as RunId | undefined;
  }

  async save(digest: Digest): Promise<void> {
    const s = digest.toSnapshot();
    const changes = {
      status: s.status,
      export_key: s.exportKey,
      item_count: s.itemCount,
      failed_sources: JSON.stringify(s.failedSources),
      analysis_batch_ref: s.analysisBatchRef,
      reanalysis_batch_ref: s.reanalysisBatchRef,
      embedding_batch_ref: s.embeddingBatchRef,
      synthesis_batch_ref: s.synthesisBatchRef,
      clusters: JSON.stringify(s.clusters),
      overview: s.overview,
      analyzed_count: s.analyzedCount,
      failed_item_count: s.failedItemCount,
      input_tokens: s.usage.inputTokens,
      output_tokens: s.usage.outputTokens,
      cost_usd: s.usage.costUsd,
      failure_reason: s.failureReason,
      published_at: s.publishedAt,
      updated_at: s.updatedAt,
    };
    await this.#db
      .insertInto('digests.digest')
      .values({
        id: s.id,
        owner_id: s.ownerId,
        run_id: s.runId,
        created_at: s.createdAt,
        ...changes,
      })
      .onConflict((oc) => oc.column('id').doUpdateSet(changes))
      .execute();
  }
}

function toDomain(row: Selectable<DigestTable>): Digest {
  return Digest.restore({
    id: row.id as DigestId,
    ownerId: row.owner_id,
    runId: row.run_id as RunId,
    status: row.status,
    exportKey: row.export_key,
    itemCount: row.item_count,
    failedSources: row.failed_sources,
    analysisBatchRef: row.analysis_batch_ref,
    reanalysisBatchRef: row.reanalysis_batch_ref,
    embeddingBatchRef: row.embedding_batch_ref,
    synthesisBatchRef: row.synthesis_batch_ref,
    // Stories stored before earlier-coverage existed have no `earlier`
    clusters: row.clusters.map((cluster) => ({ ...cluster, earlier: cluster.earlier ?? null })),
    overview: row.overview,
    analyzedCount: row.analyzed_count,
    failedItemCount: row.failed_item_count,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
    },
    failureReason: row.failure_reason,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
