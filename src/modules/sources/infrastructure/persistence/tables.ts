import type { ItemKind } from '../../domain/item.ts';
import type { FetchMode, SourceKind } from '../../domain/source.ts';

export const SOURCES_SCHEMA = 'sources';

export type SourceTable = {
  id: string;
  owner_id: string;
  name: string;
  url: string;
  kind: SourceKind;
  fetch_mode: FetchMode;
  fetch_articles: boolean;
  link_selector: string | null;
  url_pattern: string | null;
  content_selector: string | null;
  enabled: boolean;
  etag: string | null;
  last_modified: string | null;
  last_collected_at: Date | null;
  consecutive_failures: number;
  last_error: string | null;
  baselined_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ItemTable = {
  id: string;
  source_id: string;
  kind: ItemKind;
  url: string;
  title: string;
  published_at: Date | null;
  discovered_at: Date;
  baseline: boolean;
  raw_key: string;
  text_key: string;
  exported_in_run: string | null;
};

export type PageSnapshotTable = {
  source_id: string;
  url: string;
  content_hash: string;
  text: string;
  taken_at: Date;
};

/** Tables owned by this context. Other contexts never query them. */
export type SourcesTables = {
  'sources.source': SourceTable;
  'sources.item': ItemTable;
  'sources.page_snapshot': PageSnapshotTable;
};
