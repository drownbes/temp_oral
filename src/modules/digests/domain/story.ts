/** One story: items from one or more sources about the same thing. */
export interface StoryCluster {
  /** The lead item's id: stable for the same input, readable in logs. */
  readonly id: string;
  /** Lead item first (the most relevant), then the other coverage. */
  readonly itemIds: readonly string[];
  /** Merged by synthesis when several sources cover the story; otherwise the lead item's. */
  readonly headline: string | null;
  readonly summary: string | null;
}

export interface StoryText {
  readonly headline: string;
  readonly summary: string;
}
