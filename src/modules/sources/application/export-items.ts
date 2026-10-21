import type { ItemRepository } from '../domain/item-repository.ts';
import { parseRunId } from '../domain/run-id.ts';
import type { SourceRepository } from '../domain/source-repository.ts';
import { mapConcurrent } from './concurrency.ts';
import type { ItemContentStore, ItemExporter } from './ports.ts';

export interface ExportItemsResult {
  readonly exportKey: string;
  readonly itemCount: number;
}

export interface ExportItemsDeps {
  readonly items: ItemRepository;
  readonly sources: SourceRepository;
  readonly contentStore: ItemContentStore;
  readonly exporter: ItemExporter;
}

const TEXT_READ_CONCURRENCY = 8;

/**
 * Claims every item not yet handed to a digest for `runId` and writes them to the export.
 * Idempotent: running it again for the same run rewrites the same file.
 */
export class ExportItems {
  readonly #deps: ExportItemsDeps;

  constructor(deps: ExportItemsDeps) {
    this.#deps = deps;
  }

  async execute(rawRunId: string): Promise<ExportItemsResult> {
    const { items, sources, contentStore, exporter } = this.#deps;
    const runId = parseRunId(rawRunId);
    const claimed = (await items.claimForRun(runId)).map((i) => i.toSnapshot());

    const sourceIds = [...new Set(claimed.map((i) => i.sourceId))];
    const names = new Map(
      (await sources.findByIds(sourceIds)).map((s) => [s.id, s.toSnapshot().name]),
    );
    const lines = await mapConcurrent(claimed, TEXT_READ_CONCURRENCY, async (item) => ({
      item,
      sourceName: names.get(item.sourceId) ?? '',
      text: await contentStore.readText(item.content.textKey),
    }));

    const exportKey = await exporter.write(runId, lines);
    return { exportKey, itemCount: lines.length };
  }
}
