import { z } from 'zod';
import type {
  AnalysisRequest,
  AnalysisResults,
  BatchState,
  ItemAnalyzer,
} from '../../application/ports.ts';
import type { TokenUsage } from '../../domain/digest.ts';
import { type ItemAnalysis, itemAnalysis } from '../../domain/digest-entry.ts';
import { addUsage, type ChatModelOptions, chatRequest, readChatAnswer } from './chat-completion.ts';
import { type BatchClient, toBatchState } from './openai-batch-client.ts';
import { ITEM_ANALYSIS_SCHEMA, itemSystemPrompt, itemUserPrompt } from './prompts.ts';

const AnalysisJson = z.object({
  summary: z.string().min(1),
  relevance: z.number(),
  reason: z.string(),
  tags: z.array(z.string()),
});

/** One chat completion per item, run through the Batch API (half price, up to 24h). */
export class OpenAiItemAnalyzer implements ItemAnalyzer {
  readonly #batches: BatchClient;
  readonly #options: ChatModelOptions;

  constructor(batches: BatchClient, options: ChatModelOptions) {
    this.#batches = batches;
    this.#options = options;
  }

  submit(request: AnalysisRequest): Promise<string> {
    const system = itemSystemPrompt(request.interests);
    return this.#batches.submit(
      request.key,
      '/v1/chat/completions',
      request.items.map((item) => ({
        customId: item.itemId,
        body: chatRequest(this.#options, {
          system,
          user: itemUserPrompt(item),
          schemaName: 'item_analysis',
          schema: ITEM_ANALYSIS_SCHEMA,
        }),
      })),
    );
  }

  async status(batchRef: string): Promise<BatchState> {
    return toBatchState(await this.#batches.retrieve(batchRef));
  }

  async results(batchRef: string): Promise<AnalysisResults> {
    const batch = await this.#batches.retrieve(batchRef);
    const analyses = new Map<string, ItemAnalysis>();
    const failures = new Map<string, string>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for (const line of await this.#batches.results(batch)) {
      const answer = readChatAnswer(line, AnalysisJson);
      usage = addUsage(usage, answer.usage);
      if (answer.ok) analyses.set(line.customId, itemAnalysis(answer.value));
      else failures.set(line.customId, answer.failure);
    }
    return { analyses, failures, usage };
  }
}
