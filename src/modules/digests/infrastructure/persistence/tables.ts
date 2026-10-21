import type { ColumnType } from 'kysely';
import type { DigestStatus, FailedSource } from '../../domain/digest.ts';

export const DIGESTS_SCHEMA = 'digests';

export type DigestTable = {
  id: string;
  owner_id: string;
  run_id: string;
  status: DigestStatus;
  export_key: string | null;
  item_count: number;
  // jsonb: pg parses it on read, but must be given a JSON string on write
  failed_sources: ColumnType<FailedSource[], string, string>;
  batch_ref: string | null;
  analyzed_count: number;
  failed_item_count: number;
  input_tokens: number;
  output_tokens: number;
  failure_reason: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type DigestEntryTable = {
  digest_id: string;
  item_id: string;
  source_id: string;
  source_name: string;
  url: string;
  title: string;
  published_at: Date | null;
  summary: string | null;
  relevance: number | null;
  reason: string | null;
  tags: string[] | null;
  failure: string | null;
};

export type InterestProfileTable = {
  owner_id: string;
  interests: string;
  relevance_threshold: number;
  updated_at: Date;
};

/** Tables owned by this context. Other contexts never query them. */
export type DigestsTables = {
  'digests.digest': DigestTable;
  'digests.digest_entry': DigestEntryTable;
  'digests.interest_profile': InterestProfileTable;
};
