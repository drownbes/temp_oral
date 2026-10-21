import { z } from 'zod';
import type {
  BatchState,
  EmbeddingRequest,
  EmbeddingResults,
  ItemEmbedder,
} from '../../application/ports.ts';
import { type BatchClient, toBatchState } from './openai-batch-client.ts';

export interface OpenAiItemEmbedderOptions {
  readonly model: string;
  /** Shorter vectors (text-embedding-3 models) cost the same but store and compare faster. */
  readonly dimensions: number;
}

/** Enough of an article to tell which story it is about; well within the 8k-token limit. */
const EMBEDDING_INPUT_CHARS = 4000;

const EmbeddingBody = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })).min(1),
  usage: z.object({ prompt_tokens: z.number() }).nullish(),
});

/** One /v1/embeddings request per item, run through the Batch API. */
export class OpenAiItemEmbedder implements ItemEmbedder {
  readonly #batches: BatchClient;
  readonly #options: OpenAiItemEmbedderOptions;

  constructor(batches: BatchClient, options: OpenAiItemEmbedderOptions) {
    this.#batches = batches;
    this.#options = options;
  }

  submit(request: EmbeddingRequest): Promise<string> {
    const { model, dimensions } = this.#options;
    return this.#batches.submit(
      request.key,
      '/v1/embeddings',
      request.items.map((item) => ({
        customId: item.itemId,
        body: {
          model,
          dimensions,
          input: `${item.title}\n\n${item.text.slice(0, EMBEDDING_INPUT_CHARS)}`.trim(),
        },
      })),
    );
  }

  async status(batchRef: string): Promise<BatchState> {
    return toBatchState(await this.#batches.retrieve(batchRef));
  }

  /** Items whose request failed simply have no embedding; grouping treats them as unique. */
  async results(batchRef: string): Promise<EmbeddingResults> {
    const batch = await this.#batches.retrieve(batchRef);
    const embeddings = new Map<string, readonly number[]>();
    let inputTokens = 0;
    for (const line of await this.#batches.results(batch)) {
      if (line.error) continue;
      const parsed = EmbeddingBody.safeParse(line.body);
      if (!parsed.success || !parsed.data.data[0]) continue;
      embeddings.set(line.customId, parsed.data.data[0].embedding);
      inputTokens += parsed.data.usage?.prompt_tokens ?? 0;
    }
    return { embeddings, usage: { inputTokens, outputTokens: 0 } };
  }
}
