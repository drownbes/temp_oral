import type { Batch } from 'openai/resources/batches';
import { z } from 'zod';
import type {
  AnalysisRequest,
  AnalysisResults,
  BatchState,
  ItemAnalyzer,
} from '../../application/ports.ts';
import { type ItemAnalysis, itemAnalysis } from '../../domain/digest-entry.ts';
import type { BatchClient } from './openai-batch-client.ts';
import { ITEM_ANALYSIS_SCHEMA, itemSystemPrompt, itemUserPrompt } from './prompts.ts';

const AnalysisJson = z.object({
  summary: z.string().min(1),
  relevance: z.number(),
  reason: z.string(),
  tags: z.array(z.string()),
});

/** The part of a chat completion we read; everything else is ignored. */
const ChatCompletionBody = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
});

export interface OpenAiItemAnalyzerOptions {
  readonly model: string;
  /** Sent as `reasoning_effort` when set (reasoning models only). */
  readonly reasoningEffort: string | undefined;
}

/** One chat completion per item, run through the Batch API (half price, up to 24h). */
export class OpenAiItemAnalyzer implements ItemAnalyzer {
  readonly #batches: BatchClient;
  readonly #options: OpenAiItemAnalyzerOptions;

  constructor(batches: BatchClient, options: OpenAiItemAnalyzerOptions) {
    this.#batches = batches;
    this.#options = options;
  }

  submit(request: AnalysisRequest): Promise<string> {
    const { model, reasoningEffort } = this.#options;
    const system = itemSystemPrompt(request.interests);
    return this.#batches.submit(
      request.key,
      '/v1/chat/completions',
      request.items.map((item) => ({
        customId: item.itemId,
        body: {
          model,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: itemUserPrompt(item) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'item_analysis', strict: true, schema: ITEM_ANALYSIS_SCHEMA },
          },
        },
      })),
    );
  }

  async status(batchRef: string): Promise<BatchState> {
    return toState(await this.#batches.retrieve(batchRef));
  }

  async results(batchRef: string): Promise<AnalysisResults> {
    const batch = await this.#batches.retrieve(batchRef);
    const analyses = new Map<string, ItemAnalysis>();
    const failures = new Map<string, string>();
    let inputTokens = 0;
    let outputTokens = 0;

    for (const line of await this.#batches.results(batch)) {
      if (line.error) {
        failures.set(line.customId, line.error);
        continue;
      }
      const parsed = ChatCompletionBody.safeParse(line.body);
      if (!parsed.success) {
        failures.set(line.customId, 'unexpected response shape');
        continue;
      }
      inputTokens += parsed.data.usage?.prompt_tokens ?? 0;
      outputTokens += parsed.data.usage?.completion_tokens ?? 0;
      const outcome = toAnalysis(parsed.data);
      if (typeof outcome === 'string') failures.set(line.customId, outcome);
      else analyses.set(line.customId, outcome);
    }
    return { analyses, failures, usage: { inputTokens, outputTokens } };
  }
}

function toAnalysis(body: z.infer<typeof ChatCompletionBody>): ItemAnalysis | string {
  const [choice] = body.choices;
  if (!choice) return 'no choices in response';
  if (choice.message.refusal) return `refused: ${choice.message.refusal}`;
  if (choice.finish_reason === 'length') return 'answer cut off (token limit)';
  try {
    return itemAnalysis(AnalysisJson.parse(JSON.parse(choice.message.content ?? '')));
  } catch {
    return 'malformed analysis JSON';
  }
}

function toState(batch: Batch): BatchState {
  switch (batch.status) {
    case 'completed':
      return { state: 'completed' };
    case 'expired':
      return { state: 'incomplete', reason: 'batch expired before finishing' };
    case 'cancelled':
      return { state: 'incomplete', reason: 'batch was cancelled' };
    case 'failed': {
      const errors = batch.errors?.data?.map((e) => e.message).filter(Boolean) ?? [];
      return { state: 'failed', reason: errors.join('; ') || 'batch failed' };
    }
    default:
      // validating, in_progress, finalizing, cancelling
      return { state: 'pending' };
  }
}
