import type { SourceId } from './source.ts';

/**
 * Text of a watched page in a comparable form: whitespace inside lines collapsed, blank
 * lines dropped. Re-indented or re-wrapped markup therefore does not count as a change.
 */
export function normalizePageText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Short sha256 of normalised text: the identity of one version of a page. */
export async function contentHash(normalizedText: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedText));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export interface PageChange {
  /** Lines of the new version that the old one did not have, in page order. */
  readonly added: readonly string[];
  /** Lines of the old version that are gone, in page order. */
  readonly removed: readonly string[];
}

/**
 * Line-level difference of two normalised versions. Lines are compared as a multiset, so a
 * moved line is not reported; what an LLM needs is what is new and what is gone.
 */
export function describeChange(previous: string, current: string): PageChange {
  const remaining = (lines: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const before = previous.split('\n').filter(Boolean);
  const after = current.split('\n').filter(Boolean);
  const beforeLeft = remaining(before);
  const added = after.filter((line) => {
    const n = beforeLeft.get(line) ?? 0;
    if (n > 0) beforeLeft.set(line, n - 1);
    return n === 0;
  });
  const afterLeft = remaining(after);
  const removed = before.filter((line) => {
    const n = afterLeft.get(line) ?? 0;
    if (n > 0) afterLeft.set(line, n - 1);
    return n === 0;
  });
  return { added, removed };
}

const MAX_CHANGE_LINES = 60;

/** The change as text for the digest: added lines first, then removed ones, both capped. */
export function changeText(change: PageChange): string {
  const section = (label: string, mark: string, lines: readonly string[]) => {
    if (lines.length === 0) return [];
    const shown = lines.slice(0, MAX_CHANGE_LINES).map((line) => `${mark} ${line}`);
    const more =
      lines.length > MAX_CHANGE_LINES ? [`(${lines.length - MAX_CHANGE_LINES} more)`] : [];
    return [`${label}:`, ...shown, ...more];
  };
  return [...section('Added', '+', change.added), ...section('Removed', '-', change.removed)].join(
    '\n',
  );
}

/**
 * Each version of a watched page is its own item, but they all live at the same URL; the
 * fragment keeps item URLs (and therefore ids) distinct while still opening the page.
 */
export function changeItemUrl(pageUrl: string, hash: string): string {
  return `${pageUrl}#change-${hash}`;
}

export interface PageSnapshotState {
  readonly sourceId: SourceId;
  /** The URL the snapshot was taken of; a source pointed elsewhere starts over. */
  readonly url: string;
  readonly contentHash: string;
  readonly text: string;
  readonly takenAt: Date;
}

/** The last seen version of a watched page. One per page source. */
export class PageSnapshot {
  #state: PageSnapshotState;

  private constructor(state: PageSnapshotState) {
    this.#state = state;
  }

  static take(state: PageSnapshotState): PageSnapshot {
    return new PageSnapshot(state);
  }

  static restore(state: PageSnapshotState): PageSnapshot {
    return new PageSnapshot(state);
  }

  /** Whether `current` (hash of normalised text, at `url`) is a change worth reporting. */
  changedTo(url: string, hash: string): boolean {
    return this.#state.url === url && this.#state.contentHash !== hash;
  }

  isOf(url: string): boolean {
    return this.#state.url === url;
  }

  toSnapshot(): PageSnapshotState {
    return this.#state;
  }
}
