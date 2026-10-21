import type { Clock } from '#shared/kernel/clock.ts';
import { planCollection, uniqueEntries } from '../domain/collection.ts';
import { SourceNotFoundError } from '../domain/errors.ts';
import { Item, itemIdFor } from '../domain/item.ts';
import type { ItemRepository } from '../domain/item-repository.ts';
import { parseRunId } from '../domain/run-id.ts';
import type { SourceId } from '../domain/source.ts';
import type { SourceRepository } from '../domain/source-repository.ts';
import { mapConcurrent } from './concurrency.ts';
import type { FeedReader, ItemContentStore, PageFetcher } from './ports.ts';

export interface CollectSourceResult {
  readonly sourceId: SourceId;
  readonly status: 'collected' | 'not-modified' | 'skipped';
  readonly newItems: number;
  /** True on the source's first collection: items were recorded but won't be exported. */
  readonly baseline: boolean;
}

export interface CollectSourceDeps {
  readonly sources: SourceRepository;
  readonly items: ItemRepository;
  readonly fetcher: PageFetcher;
  readonly feedReader: FeedReader;
  readonly contentStore: ItemContentStore;
  readonly clock: Clock;
}

const CONTENT_WRITE_CONCURRENCY = 8;

/**
 * Fetches a source and stores what is new. Idempotent, because it runs as a Temporal
 * activity: item ids are deterministic, content writes overwrite, and inserts skip known ids.
 * Failures are not recorded here; the workflow records them once retries are exhausted.
 */
export class CollectSource {
  readonly #deps: CollectSourceDeps;

  constructor(deps: CollectSourceDeps) {
    this.#deps = deps;
  }

  async execute(sourceId: SourceId, rawRunId: string): Promise<CollectSourceResult> {
    const { sources, items, fetcher, feedReader, contentStore, clock } = this.#deps;
    const runId = parseRunId(rawRunId);
    const source = await sources.findById(sourceId);
    if (!source) throw new SourceNotFoundError(sourceId);
    if (!source.isCollectable) return { sourceId, status: 'skipped', newItems: 0, baseline: false };

    const { validators } = source.toSnapshot();
    const page = await fetcher.fetch({ url: source.url, validators });
    if (page.status === 'not-modified') {
      source.recordSuccess(validators, clock.now());
      await sources.save(source);
      return { sourceId, status: 'not-modified', newItems: 0, baseline: false };
    }

    const entries = uniqueEntries(feedReader.read(page.body, page.url), source.url);
    const known = await items.knownUrls(
      sourceId,
      entries.map((e) => e.url),
    );
    const plan = planCollection(source, entries, known);

    // Content first: a stored item must always have its objects
    const newItems = await mapConcurrent(
      plan.newEntries,
      CONTENT_WRITE_CONCURRENCY,
      async (entry) => {
        const itemId = await itemIdFor(sourceId, entry.url);
        const content = await contentStore.put(
          { sourceId, runId, itemId },
          { html: entry.html, text: entry.text },
        );
        return Item.discover({
          id: itemId,
          sourceId,
          url: entry.url,
          title: entry.title,
          publishedAt: entry.publishedAt,
          baseline: plan.baseline,
          content,
          now: clock.now(),
        });
      },
    );
    await items.addNew(newItems);

    source.recordSuccess(page.validators, clock.now());
    await sources.save(source);
    return { sourceId, status: 'collected', newItems: newItems.length, baseline: plan.baseline };
  }
}
