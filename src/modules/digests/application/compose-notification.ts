import type { DigestId, DigestSnapshot, FailedSource } from '../domain/digest.ts';
import { DigestNotFoundError } from '../domain/errors.ts';
import { DEFAULT_RELEVANCE_THRESHOLD } from '../domain/interest-profile.ts';
import { rankStories } from '../domain/ranking.ts';
import type {
  DigestEntryRepository,
  DigestRepository,
  InterestProfileRepository,
} from '../domain/repositories.ts';
import { storiesOf } from './stories.ts';

export type DigestEvent = 'published' | 'failed';

/** What to send; the same idempotency key is only ever sent once. */
export interface DigestNotification {
  readonly idempotencyKey: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

export interface ComposeNotificationDeps {
  readonly digests: DigestRepository;
  readonly entries: DigestEntryRepository;
  readonly profiles: InterestProfileRepository;
  /** Who is told; no notifications at all when unset. */
  readonly recipient: string | undefined;
  /** Where readers open the page, if it is served somewhere. */
  readonly pageUrl: string | undefined;
}

const TOP_HEADLINES = 5;

/**
 * Writes the message for a published or failed digest: the day's overview and top
 * headlines, or why it failed. Returns null when there is nobody to tell, or nothing to say
 * (e.g. a digest superseded by a newer day is not news).
 */
export class ComposeNotification {
  readonly #deps: ComposeNotificationDeps;

  constructor(deps: ComposeNotificationDeps) {
    this.#deps = deps;
  }

  async execute(digestId: DigestId, event: DigestEvent): Promise<DigestNotification | null> {
    const { digests, recipient } = this.#deps;
    if (!recipient) return null;
    const digest = await digests.findById(digestId);
    if (!digest) throw new DigestNotFoundError(digestId);
    const snapshot = digest.toSnapshot();
    const expected = event === 'published' ? 'published' : 'failed';
    if (snapshot.status !== expected) return null;

    const message =
      event === 'published' ? await this.#published(snapshot) : this.#failed(snapshot);
    return {
      idempotencyKey: `digest-${event}:${snapshot.ownerId}:${snapshot.runId}`,
      recipient,
      ...message,
    };
  }

  async #published(digest: DigestSnapshot): Promise<{ subject: string; body: string }> {
    const { entries, profiles, pageUrl } = this.#deps;
    const profile = (await profiles.find(digest.ownerId))?.toSnapshot();
    const ranked = rankStories(
      storiesOf(digest, await entries.listByDigest(digest.id)),
      profile?.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD,
    );

    const headlines = ranked.featured.slice(0, TOP_HEADLINES).map((story) => {
      const lead = story.entries[0];
      const headline = story.cluster.headline ?? lead?.title ?? '';
      return `- ${headline} (${story.entries.map((e) => e.sourceName).join(', ')})`;
    });
    const more = ranked.featured.length - headlines.length;
    const sections = [
      digest.overview,
      headlines.length > 0
        ? ['Highlights:', ...headlines, ...(more > 0 ? [`… and ${more} more.`] : [])].join('\n')
        : 'Nothing above your relevance threshold today.',
      failedSourcesNote(digest.failedSources),
      costNote(digest),
      pageUrl ? `Read it: ${pageUrl}` : null,
    ];
    const highlights = ranked.featured.length;
    return {
      subject:
        digest.itemCount === 0
          ? `Digest ${digest.runId}: nothing new`
          : `Digest ${digest.runId}: ${highlights} ${highlights === 1 ? 'highlight' : 'highlights'} from ${digest.itemCount} items`,
      body: sections.filter(Boolean).join('\n\n'),
    };
  }

  #failed(digest: DigestSnapshot): { subject: string; body: string } {
    return {
      subject: `Digest ${digest.runId} failed`,
      body: [
        `The digest for ${digest.runId} failed: ${digest.failureReason ?? 'unknown reason'}`,
        `Running the day again (POST /digests/runs {"runId":"${digest.runId}"}) starts it over from collection.`,
      ].join('\n\n'),
    };
  }
}

function failedSourcesNote(failed: readonly FailedSource[]): string | null {
  if (failed.length === 0) return null;
  const lines = failed.map(
    (s) =>
      `- ${s.sourceName ?? s.sourceId}: ${s.reason}${s.disabled ? ' (stopped after repeated failures; enable it again once fixed)' : ''}`,
  );
  return [
    `Could not collect ${failed.length} ${failed.length === 1 ? 'source' : 'sources'}:`,
    ...lines,
  ].join('\n');
}

function costNote(digest: DigestSnapshot): string | null {
  const { costUsd } = digest.usage;
  if (costUsd === null || costUsd === 0) return null;
  return `LLM cost: ${costUsd < 0.01 ? 'less than $0.01' : `about $${costUsd.toFixed(2)}`}.`;
}
