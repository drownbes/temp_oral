/** One story: items from one or more sources about the same thing. */
export interface StoryCluster {
  /** The lead item's id: stable for the same input, readable in logs. */
  readonly id: string;
  /** Lead item first (the most relevant), then the other coverage. */
  readonly itemIds: readonly string[];
  /** Merged by synthesis when several sources cover the story; otherwise the lead item's. */
  readonly headline: string | null;
  readonly summary: string | null;
  /** Set when an earlier digest already showed this story; null for news. */
  readonly earlier: EarlierCoverage | null;
}

/** The earlier item a story matches best, and what that makes the story. */
export interface EarlierCoverage {
  /** 'repeat': nothing new, not shown. 'follow-up': shown, labelled with the earlier report. */
  readonly kind: 'repeat' | 'follow-up';
  /** The day of the digest that showed it. */
  readonly runId: string;
  readonly sourceName: string;
  readonly title: string;
  readonly url: string;
  /** Cosine similarity of the closest pair, rounded; for tuning the thresholds. */
  readonly similarity: number;
}

export interface StoryText {
  readonly headline: string;
  readonly summary: string;
}
