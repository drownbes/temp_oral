import type { Brand } from '#shared/kernel/brand.ts';
import { ArchivedSourceError, InvalidSourceError } from './errors.ts';
import { canonicalizeUrl } from './url.ts';

export type SourceId = Brand<string, 'SourceId'>;

export const newSourceId = (): SourceId => crypto.randomUUID() as SourceId;

export const SOURCE_KINDS = ['feed', 'listing', 'page'] as const;
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
      return { kind, linkSelector: optional(input.linkSelector), urlPattern };
    }
    case 'page':
      return { kind, contentSelector: optional(input.contentSelector) };
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
  readonly settings: SourceSettings;
  readonly enabled: boolean;
  readonly validators: FetchValidators;
  readonly lastCollectedAt: Date | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
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
  readonly settings: SourceSettings;
  readonly now: Date;
}

export interface SourceChanges {
  readonly name?: string;
  readonly url?: string;
  readonly fetchMode?: FetchMode;
  readonly settings?: SourceSettings;
  readonly enabled?: boolean;
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

/** Aggregate root: a website we track, and the state of collecting it. */
export class Source {
  #state: SourceSnapshot;

  private constructor(state: SourceSnapshot) {
    this.#state = state;
  }

  static create(props: CreateSourceProps): Source {
    if (!props.ownerId.trim()) throw new InvalidSourceError('ownerId is required');
    return new Source({
      id: props.id,
      ownerId: props.ownerId,
      name: validName(props.name),
      url: validUrl(props.url),
      fetchMode: validFetchMode(props.fetchMode),
      settings: props.settings,
      enabled: true,
      validators: NO_VALIDATORS,
      lastCollectedAt: null,
      consecutiveFailures: 0,
      lastError: null,
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

  get isArchived(): boolean {
    return this.#state.archivedAt !== null;
  }

  get isBaselined(): boolean {
    return this.#state.baselinedAt !== null;
  }

  get isCollectable(): boolean {
    return this.#state.enabled && !this.isArchived;
  }

  /**
   * Pointing a source at a different URL or kind makes it a different stream of items, so
   * it starts over: no conditional-request validators and a fresh baseline.
   */
  update(changes: SourceChanges, now: Date): void {
    if (this.isArchived) throw new ArchivedSourceError(this.id);
    const s = this.#state;
    const url = changes.url === undefined ? s.url : validUrl(changes.url);
    const settings = changes.settings ?? s.settings;
    const restarts = url !== s.url || settings.kind !== s.settings.kind;

    this.#state = {
      ...s,
      name: changes.name === undefined ? s.name : validName(changes.name),
      url,
      fetchMode: changes.fetchMode === undefined ? s.fetchMode : validFetchMode(changes.fetchMode),
      settings,
      enabled: changes.enabled ?? s.enabled,
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

  recordFailure(reason: string, now: Date): void {
    this.#state = {
      ...this.#state,
      lastCollectedAt: now,
      consecutiveFailures: this.#state.consecutiveFailures + 1,
      lastError: reason.slice(0, MAX_ERROR_LENGTH),
      updatedAt: now,
    };
  }

  toSnapshot(): SourceSnapshot {
    return this.#state;
  }
}
