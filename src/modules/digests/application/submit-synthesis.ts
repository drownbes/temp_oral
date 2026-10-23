import type { Clock } from '#shared/kernel/clock.ts';
import type { DigestId } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import { DEFAULT_RELEVANCE_THRESHOLD } from '../domain/interest-profile.ts';
import { isRepeat, rankStories } from '../domain/ranking.ts';
import type {
  DigestEntryRepository,
  DigestRepository,
  InterestProfileRepository,
} from '../domain/repositories.ts';
import { batchKey } from './batch-key.ts';
import { type DigestState, toState } from './digest-state.ts';
import type { DigestSynthesizer } from './ports.ts';
import { storiesOf, storyItem } from './stories.ts';

export interface SubmitSynthesisDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly profiles: InterestProfileRepository;
  readonly synthesizer: DigestSynthesizer;
  readonly clock: Clock;
}

/** How many of the day's top stories the overview is written from. */
const OVERVIEW_STORIES = 12;

/**
 * Asks for one merged headline per multi-source story and an overview of the day's
 * highlights. With nothing to synthesise it completes right away, without a batch.
 * Idempotent like the enrichment submit: the batch is keyed by its content.
 */
export class SubmitSynthesis {
  readonly #deps: SubmitSynthesisDeps;

  constructor(deps: SubmitSynthesisDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId): Promise<DigestState> {
    const { digests, entries, profiles, synthesizer, clock } = this.#deps;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const snapshot = digest.toSnapshot();
    if (snapshot.status !== 'synthesizing' || snapshot.synthesisBatchRef) return toState(digest);

    const profile = (await profiles.find(snapshot.ownerId))?.toSnapshot();
    // Repeats are not shown, so they get neither a merged headline nor a place in the overview
    const stories = storiesOf(snapshot, await entries.listByDigest(digestId)).filter(
      (s) => !isRepeat(s),
    );
    const ranked = rankStories(stories, profile?.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD);
    // Quiet day with nothing above the threshold: write the overview from what there is
    const highlights = (ranked.featured.length > 0 ? ranked.featured : stories)
      .filter((s) => s.relevance >= 0)
      .slice(0, OVERVIEW_STORIES)
      .flatMap((s) => (s.entries[0] ? [storyItem(s.entries[0])] : []));
    const multiSource = stories
      .filter((s) => s.entries.length > 1)
      .map((s) => ({ clusterId: s.cluster.id, items: s.entries.map(storyItem) }));

    if (multiSource.length === 0 && highlights.length === 0) {
      digest.completeSynthesis(
        { stories: new Map(), overview: null, usage: { inputTokens: 0, outputTokens: 0 } },
        clock.now(),
      );
    } else {
      const interests = profile?.interests ?? '';
      const ref = await synthesizer.submit({
        key: await batchKey(digestId, 'synthesis', { interests, multiSource, highlights }),
        interests,
        stories: multiSource,
        highlights,
      });
      digest.synthesisSubmitted(ref, clock.now());
    }
    await digests.save(digest);
    return toState(digest);
  }
}
