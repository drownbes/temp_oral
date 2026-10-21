import { InvalidProfileError } from './errors.ts';

export interface InterestProfileSnapshot {
  readonly ownerId: string;
  /** Free text: what the reader cares about. Empty means "rank by general significance". */
  readonly interests: string;
  /** Items scored below this go to "Also noted" with their headline only. */
  readonly relevanceThreshold: number;
  readonly updatedAt: Date;
}

export const DEFAULT_RELEVANCE_THRESHOLD = 0.5;
const MAX_INTERESTS_LENGTH = 4000;

/** What one reader wants from their digest. One per owner. */
export class InterestProfile {
  #state: InterestProfileSnapshot;

  private constructor(state: InterestProfileSnapshot) {
    this.#state = state;
  }

  /** The profile of someone who never set one. */
  static initial(ownerId: string, now: Date): InterestProfile {
    return new InterestProfile({
      ownerId,
      interests: '',
      relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
      updatedAt: now,
    });
  }

  static restore(snapshot: InterestProfileSnapshot): InterestProfile {
    return new InterestProfile(snapshot);
  }

  change(changes: { interests?: string; relevanceThreshold?: number }, now: Date): void {
    const interests = changes.interests?.trim() ?? this.#state.interests;
    if (interests.length > MAX_INTERESTS_LENGTH) {
      throw new InvalidProfileError(`interests must be at most ${MAX_INTERESTS_LENGTH} characters`);
    }
    const threshold = changes.relevanceThreshold ?? this.#state.relevanceThreshold;
    if (!(threshold >= 0 && threshold <= 1)) {
      throw new InvalidProfileError('relevanceThreshold must be between 0 and 1');
    }
    this.#state = { ...this.#state, interests, relevanceThreshold: threshold, updatedAt: now };
  }

  toSnapshot(): InterestProfileSnapshot {
    return this.#state;
  }
}
