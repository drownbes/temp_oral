import type { DocumentStatus } from '../../domain/document.ts';

export const DOCUMENTS_SCHEMA = 'documents';

export type DocumentTable = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string;
  status: DocumentStatus;
  checksum: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Tables owned by this context. Other contexts never query them. */
export type DocumentsTables = {
  'documents.document': DocumentTable;
};
