import type { Kysely, Selectable } from 'kysely';
import { DuplicateSourceError } from '../../domain/errors.ts';
import { Source, type SourceId, type SourceSettings } from '../../domain/source.ts';
import type { SourceRepository } from '../../domain/source-repository.ts';
import type { SourcesTables, SourceTable } from './tables.ts';

const UNIQUE_VIOLATION = '23505';
const ACTIVE_URL_CONSTRAINT = 'source_owner_url_active_key';

export class KyselySourceRepository implements SourceRepository {
  readonly #db: Kysely<SourcesTables>;

  constructor(db: Kysely<SourcesTables>) {
    this.#db = db;
  }

  async findById(id: SourceId): Promise<Source | undefined> {
    const row = await this.#db
      .selectFrom('sources.source')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toDomain(row);
  }

  async findByIds(ids: readonly SourceId[]): Promise<Source[]> {
    if (ids.length === 0) return [];
    const rows = await this.#db
      .selectFrom('sources.source')
      .selectAll()
      .where('id', 'in', ids)
      .execute();
    return rows.map(toDomain);
  }

  async findActiveByUrl(ownerId: string, url: string): Promise<Source | undefined> {
    const row = await this.#db
      .selectFrom('sources.source')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('url', '=', url)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return row && toDomain(row);
  }

  async listActive(ownerId: string): Promise<Source[]> {
    const rows = await this.#db
      .selectFrom('sources.source')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('archived_at', 'is', null)
      .orderBy('created_at')
      .execute();
    return rows.map(toDomain);
  }

  async listCollectable(): Promise<Source[]> {
    const rows = await this.#db
      .selectFrom('sources.source')
      .selectAll()
      .where('enabled', '=', true)
      .where('archived_at', 'is', null)
      .orderBy('created_at')
      .execute();
    return rows.map(toDomain);
  }

  async save(source: Source): Promise<void> {
    const { id, created_at, ...changes } = toRow(source);
    try {
      await this.#db
        .insertInto('sources.source')
        .values({ id, created_at, ...changes })
        .onConflict((oc) => oc.column('id').doUpdateSet(changes))
        .execute();
    } catch (err) {
      const pg = err as { code?: string; constraint?: string };
      if (pg.code === UNIQUE_VIOLATION && pg.constraint === ACTIVE_URL_CONSTRAINT) {
        throw new DuplicateSourceError(source.url);
      }
      throw err;
    }
  }
}

function toSettings(row: Selectable<SourceTable>): SourceSettings {
  switch (row.kind) {
    case 'feed':
      return { kind: 'feed', fetchArticles: row.fetch_articles };
    case 'listing':
      return { kind: 'listing', linkSelector: row.link_selector, urlPattern: row.url_pattern };
    case 'page':
      return { kind: 'page', contentSelector: row.content_selector };
    case 'youtube':
      return { kind: 'youtube' };
  }
}

function toDomain(row: Selectable<SourceTable>): Source {
  return Source.restore({
    id: row.id as SourceId,
    ownerId: row.owner_id,
    name: row.name,
    url: row.url,
    fetchMode: row.fetch_mode,
    waitForSelector: row.wait_for_selector,
    settings: toSettings(row),
    enabled: row.enabled,
    validators: { etag: row.etag, lastModified: row.last_modified },
    lastCollectedAt: row.last_collected_at,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    disabledReason: row.disabled_reason,
    baselinedAt: row.baselined_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toRow(source: Source): SourceTable {
  const s = source.toSnapshot();
  const { settings } = s;
  return {
    id: s.id,
    owner_id: s.ownerId,
    name: s.name,
    url: s.url,
    kind: settings.kind,
    fetch_mode: s.fetchMode,
    wait_for_selector: s.waitForSelector,
    fetch_articles: settings.kind === 'feed' ? settings.fetchArticles : true,
    link_selector: settings.kind === 'listing' ? settings.linkSelector : null,
    url_pattern: settings.kind === 'listing' ? settings.urlPattern : null,
    content_selector: settings.kind === 'page' ? settings.contentSelector : null,
    enabled: s.enabled,
    etag: s.validators.etag,
    last_modified: s.validators.lastModified,
    last_collected_at: s.lastCollectedAt,
    consecutive_failures: s.consecutiveFailures,
    last_error: s.lastError,
    disabled_reason: s.disabledReason,
    baselined_at: s.baselinedAt,
    archived_at: s.archivedAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}
