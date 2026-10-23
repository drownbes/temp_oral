import type { Brand } from '#shared/kernel/brand.ts';
import { ArchivedSourceError, InvalidSourceError } from './errors.ts';
import { canonicalizeUrl } from './url.ts';
import { youtubeChannelIdOf, youtubeChannelUrl, youtubeFeedUrl } from './youtube.ts';

export type SourceId = Brand<string, 'SourceId'>;

export const newSourceId = (): SourceId => crypto.randomUUID() as SourceId;

export const SOURCE_KINDS = ['feed', 'listing', 'page', 'youtube'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const FETCH_MODES = ['http', 'browser'] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

/** How to read a source. The kind lives here, so its options always match it. */
export type SourceSettings =
  | {
      readonly kind: 'feed';
      /** Fetch each new article's page when the feed only carries a teaser. */
      readonly fetchArticles: boolean;
    }
  | {
      readonly kind: 'listing';
      /** CSS selector of article links on the index page. */
      readonly linkSelector: string | null;
      /** Regular expression an article URL must match. */
      readonly urlPattern: string | null;
    }
  | {
      readonly kind: 'page';
      /** CSS selector of the part of the page to watch; the whole page when null. */
      readonly contentSelector: string | null;
    }
  | {
      /** A channel: each new video (not Shorts), with its transcript where it has one. */
      readonly kind: 'youtube';
    };

export interface SourceSettingsInput {
  readonly fetchArticles?: boolean | null;
  readonly linkSelector?: string | null;
  readonly urlPattern?: string | null;
  readonly contentSelector?: string | null;
}

/** Validates kind-specific options and drops the ones that do not apply to `kind`. */
export function sourceSettings(kind: SourceKind, input: SourceSettingsInput = {}): SourceSettings {
  const optional = (value: string | null | undefined) => value?.trim() || null;
  switch (kind) {
    case 'feed':
      return { kind, fetchArticles: input.fetchArticles ?? true };
    case 'listing': {
      const urlPattern = optional(input.urlPattern);
      if (urlPattern) {
        try {
          new RegExp(urlPattern);
        } catch {
          throw new InvalidSourceError(`urlPattern is not a valid regular expression`);
        }
      }
      const linkSelector = optional(input.linkSelector);
      // Without either, "every link" would include navigation, tags and footers
      if (!linkSelector && !urlPattern) {
        throw new InvalidSourceError('listing sources need a linkSelector or a urlPattern');
      }
      return { kind, linkSelector, urlPattern };
    }
    case 'page':
      return { kind, contentSelector: optional(input.contentSelector) };
    case 'youtube':
      return { kind };
    default:
      throw new InvalidSourceError(`unknown source kind "${kind as string}"`);
  }
}

/** HTTP validators from the last successful fetch, sent back for conditional requests. */
export interface FetchValidators {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface SourceSnapshot {
  readonly id: SourceId;
  readonly ownerId: string;
  readonly name: string;
  readonly url: string;
  readonly fetchMode: FetchMode;
  /**
   * Browser sources only: the page is read once an element matches this CSS selector,
   * otherwise once the network is idle. Always null for HTTP sources.
   */
  readonly waitForSelector: string | null;
  readonly settings: SourceSettings;
  readonly enabled: boolean;
  readonly validators: FetchValidators;
  readonly lastCollectedAt: Date | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  /** Why collecting stopped by itself (too many failures in a row); null otherwise. */
  readonly disabledReason: string | null;
  /** Set by the first successful collection; until then items are recorded as already seen. */
  readonly baselinedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateSourceProps {
  readonly id: SourceId;
  readonly ownerId: string;
  readonly name: string;
  readonly url: string;
  readonly fetchMode: FetchMode;
  readonly waitForSelector?: string | null;
  readonly settings: SourceSettings;
  readonly now: Date;
}

export interface SourceChanges {
  readonly name?: string;
  readonly url?: string;
  readonly fetchMode?: FetchMode;
  /** null clears it; omitted keeps it (as long as the source stays a browser source). */
  readonly waitForSelector?: string | null;
  readonly settings?: SourceSettings;
  readonly enabled?: boolean;
}

/**
 * ok: last collection worked. failing: the last ones failed, still collected.
 * disabled: stopped after too many failures in a row; enabling it again starts over.
 */
export type SourceHealth = 'ok' | 'failing' | 'disabled';

export function healthOf(source: SourceSnapshot): SourceHealth {
  if (source.disabledReason !== null) return 'disabled';
  return source.consecutiveFailures > 0 ? 'failing' : 'ok';
}

const NO_VALIDATORS: FetchValidators = { etag: null, lastModified: null };
const MAX_ERROR_LENGTH = 1000;

function validName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidSourceError('name is required');
  if (trimmed.length > 200) throw new InvalidSourceError('name is too long');
  return trimmed;
}

function validUrl(url: string): string {
  const canonical = canonicalizeUrl(url);
  if (!canonical) throw new InvalidSourceError('url must be an absolute http(s) URL');
  return canonical;
}

function validFetchMode(fetchMode: FetchMode): FetchMode {
  if (!FETCH_MODES.includes(fetchMode)) {
    throw new InvalidSourceError(`unknown fetch mode "${fetchMode as string}"`);
  }
  return fetchMode;
}

/**
 * A YouTube source is a channel read through its feed: its URL must name the channel (a
 * handle is resolved to it first) and it is read over plain HTTP. Returns the channel URL.
 */
export function youtubeChannelSource(url: string, fetchMode: FetchMode): string {
  if (fetchMode !== 'http') {
    throw new InvalidSourceError('youtube sources are read over http, not in a browser');
  }
  const channelId = youtubeChannelIdOf(url);
  if (!channelId) {
    throw new InvalidSourceError('youtube sources need a channel URL (youtube.com/channel/UC…)');
  }
  return youtubeChannelUrl(channelId);
}

/** Where a source is read from: a YouTube channel's feed, otherwise the source URL itself. */
export function fetchUrlOf(kind: SourceKind, url: string): string {
  const channelId = kind === 'youtube' ? youtubeChannelIdOf(url) : undefined;
  return channelId ? youtubeFeedUrl(channelId) : url;
}

function validTarget(settings: SourceSettings, url: string, fetchMode: FetchMode): string {
  return settings.kind === 'youtube' ? youtubeChannelSource(url, fetchMode) : url;
}

/** Waiting only means something in a browser, so HTTP sources never keep a selector. */
function validWaitForSelector(fetchMode: FetchMode, selector: string | null): string | null {
  const trimmed = selector?.trim() || null;
  if (fetchMode !== 'browser' || !trimmed) return null;
  if (trimmed.length > 500) throw new InvalidSourceError('waitForSelector is too long');
  return trimmed;
}

/** Aggregate root: a website we track, and the state of collecting it. */
export class Source {
  #state: SourceSnapshot;

  private constructor(state: SourceSnapshot) {
    this.#state = state;
  }

  static create(props: CreateSourceProps): Source {
    if (!props.ownerId.trim()) throw new InvalidSourceError('ownerId is required');
    const fetchMode = validFetchMode(props.fetchMode);
    return new Source({
      id: props.id,
      ownerId: props.ownerId,
      name: validName(props.name),
      url: validTarget(props.settings, validUrl(props.url), fetchMode),
      fetchMode,
      waitForSelector: validWaitForSelector(fetchMode, props.waitForSelector ?? null),
      settings: props.settings,
      enabled: true,
      validators: NO_VALIDATORS,
      lastCollectedAt: null,
      consecutiveFailures: 0,
      lastError: null,
      disabledReason: null,
      baselinedAt: null,
      archivedAt: null,
      createdAt: props.now,
      updatedAt: props.now,
    });
  }

  /** Rehydrates from persistence; no invariants re-checked. */
  static restore(snapshot: SourceSnapshot): Source {
    return new Source(snapshot);
  }

  get id(): SourceId {
    return this.#state.id;
  }

  get url(): string {
    return this.#state.url;
  }

  get kind(): SourceKind {
    return this.#state.settings.kind;
  }

  get fetchUrl(): string {
    return fetchUrlOf(this.kind, this.url);
  }

  get fetchMode(): FetchMode {
    return this.#state.fetchMode;
  }

  get isArchived(): boolean {
    return this.#state.archivedAt !== null;
  }

  get isBaselined(): boolean {
    return this.#state.baselinedAt !== null;
  }

  get isCollectable(): boolean {
    return this.#state.enabled && !this.isArchived;
  }

  get name(): string {
    return this.#state.name;
  }

  get health(): SourceHealth {
    return healthOf(this.#state);
  }

  /**
   * Pointing a source at a different URL or kind makes it a different stream of items, so
   * it starts over: no conditional-request validators and a fresh baseline.
   */
  update(changes: SourceChanges, now: Date): void {
    if (this.isArchived) throw new ArchivedSourceError(this.id);
    const s = this.#state;
    const settings = changes.settings ?? s.settings;
    const fetchMode =
      changes.fetchMode === undefined ? s.fetchMode : validFetchMode(changes.fetchMode);
    const url = validTarget(
      settings,
      changes.url === undefined ? s.url : validUrl(changes.url),
      fetchMode,
    );
    const restarts = url !== s.url || settings.kind !== s.settings.kind;
    const waitForSelector = validWaitForSelector(
      fetchMode,
      changes.waitForSelector === undefined ? s.waitForSelector : changes.waitForSelector,
    );
    const enabled = changes.enabled ?? s.enabled;
    // Switched on or off by hand: whatever stopped it by itself no longer applies, and a
    // source enabled again gets a full set of tries before it is stopped again
    const switched = changes.enabled !== undefined && changes.enabled !== s.enabled;

    this.#state = {
      ...s,
      name: changes.name === undefined ? s.name : validName(changes.name),
      url,
      fetchMode,
      waitForSelector,
      settings,
      enabled,
      ...(switched ? { disabledReason: null, consecutiveFailures: 0 } : {}),
      ...(restarts ? { validators: NO_VALIDATORS, baselinedAt: null } : {}),
      updatedAt: now,
    };
  }

  archive(now: Date): void {
    if (this.isArchived) return;
    this.#state = { ...this.#state, enabled: false, archivedAt: now, updatedAt: now };
  }

  recordSuccess(validators: FetchValidators, now: Date): void {
    this.#state = {
      ...this.#state,
      validators,
      lastCollectedAt: now,
      consecutiveFailures: 0,
      lastError: null,
      baselinedAt: this.#state.baselinedAt ?? now,
      updatedAt: now,
    };
  }

  /**
   * A collection run failed for good (after its retries). After `maxConsecutiveFailures` in
   * a row the source stops being collected, so a dead site does not fail every run forever.
   */
  recordFailure(reason: string, now: Date, maxConsecutiveFailures: number): void {
    const consecutiveFailures = this.#state.consecutiveFailures + 1;
    const stops = this.#state.enabled && consecutiveFailures >= maxConsecutiveFailures;
    this.#state = {
      ...this.#state,
      lastCollectedAt: now,
      consecutiveFailures,
      lastError: reason.slice(0, MAX_ERROR_LENGTH),
      ...(stops
        ? {
            enabled: false,
            disabledReason: `stopped after ${consecutiveFailures} failed collections in a row`,
          }
        : {}),
      updatedAt: now,
    };
  }

  toSnapshot(): SourceSnapshot {
    return this.#state;
  }
}
