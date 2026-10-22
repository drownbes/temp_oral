import type { Brand } from '#shared/kernel/brand.ts';
import type { RunId } from './run-id.ts';
import type { SourceId } from './source.ts';

/** Deterministic: derived from the source and the canonical URL (see `itemIdFor`). */
export type ItemId = Brand<string, 'ItemId'>;

/**
 * The same article of the same source always gets the same id, so collecting twice (a
 * retried activity, a re-run) never duplicates it. Formatted as a UUIDv8 (custom) of sha256.
 */
export async function itemIdFor(sourceId: SourceId, canonicalUrl: string): Promise<ItemId> {
  const input = new TextEncoder().encode(`${sourceId}\n${canonicalUrl}`);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const parts = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20)];
  return `${parts.join('-')}-${hex.slice(20)}` as ItemId;
}

/** An article (feed entry, listing link) or a detected change of a watched page. */
export type ItemKind = 'article' | 'change';

export interface ItemContentKeys {
  readonly rawKey: string;
  readonly textKey: string;
}

export interface ItemSnapshot {
  readonly id: ItemId;
  readonly sourceId: SourceId;
  readonly kind: ItemKind;
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly discoveredAt: Date;
  /** Seen during the source's first collection: remembered, but never handed to a digest. */
  readonly baseline: boolean;
  readonly content: ItemContentKeys;
  /**
   * The run that handed this item to a digest. Each non-baseline item is claimed by exactly
   * one run; the repository does the claim atomically so overlapping runs cannot share items.
   */
  readonly exportedInRun: RunId | null;
}

export interface DiscoverItemProps {
  readonly id: ItemId;
  /** Defaults to 'article'. */
  readonly kind?: ItemKind;
  readonly sourceId: SourceId;
  readonly url: string;
  readonly title: string;
  readonly publishedAt: Date | null;
  readonly baseline: boolean;
  readonly content: ItemContentKeys;
  readonly now: Date;
}

const MAX_TITLE_LENGTH = 500;

/** Something new found on a source, e.g. one article of a feed. */
export class Item {
  #state: ItemSnapshot;

  private constructor(state: ItemSnapshot) {
    this.#state = state;
  }

  static discover(props: DiscoverItemProps): Item {
    const title = props.title.replace(/\s+/g, ' ').trim() || props.url;
    return new Item({
      id: props.id,
      sourceId: props.sourceId,
      kind: props.kind ?? 'article',
      url: props.url,
      title: title.slice(0, MAX_TITLE_LENGTH),
      publishedAt: props.publishedAt,
      discoveredAt: props.now,
      baseline: props.baseline,
      content: props.content,
      exportedInRun: null,
    });
  }

  static restore(snapshot: ItemSnapshot): Item {
    return new Item(snapshot);
  }

  get id(): ItemId {
    return this.#state.id;
  }

  toSnapshot(): ItemSnapshot {
    return this.#state;
  }
}
