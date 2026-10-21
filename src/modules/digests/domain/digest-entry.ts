import type { DigestId } from './digest.ts';

/** What the LLM made of one item, normalised by `itemAnalysis`. */
export interface ItemAnalysis {
  readonly summary: string;
  /** 0 = irrelevant to the reader, 1 = must read. */
  readonly relevance: number;
  /** One line on why it got that score. */
  readonly reason: string;
  readonly tags: readonly string[];
}

/** One collected item as it appears in a digest, with its analysis when it succeeded. */
export interface DigestEntry {
  readonly digestId: DigestId;
  readonly itemId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly analysis: ItemAnalysis | null;
  /** Why there is no analysis (LLM error, refusal, malformed answer, missing from batch). */
  readonly failure: string | null;
}

const MAX_SUMMARY_LENGTH = 2000;
const MAX_REASON_LENGTH = 300;
const MAX_TAGS = 5;

/** Clamps and tidies model output so the page never depends on the model behaving. */
export function itemAnalysis(raw: {
  summary: string;
  relevance: number;
  reason: string;
  tags: readonly string[];
}): ItemAnalysis {
  const relevance = Number.isFinite(raw.relevance) ? Math.min(1, Math.max(0, raw.relevance)) : 0;
  const tags = [...new Set(raw.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  return {
    summary: raw.summary.trim().slice(0, MAX_SUMMARY_LENGTH),
    relevance,
    reason: raw.reason.trim().slice(0, MAX_REASON_LENGTH),
    tags: tags.slice(0, MAX_TAGS),
  };
}
