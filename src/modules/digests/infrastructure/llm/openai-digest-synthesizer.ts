import { z } from 'zod';
import type {
  BatchState,
  DigestSynthesizer,
  SynthesisRequest,
  SynthesisResults,
} from '../../application/ports.ts';
import type { StoryText } from '../../domain/story.ts';
import {
  addCounts,
  type ChatModelOptions,
  chatRequest,
  readChatAnswer,
} from './chat-completion.ts';
import { type BatchClient, toBatchState } from './openai-batch-client.ts';
import { type ModelPrice, priced, type TokenCounts } from './pricing.ts';
import {
  OVERVIEW_SCHEMA,
  overviewSystemPrompt,
  overviewUserPrompt,
  STORY_SCHEMA,
  storySystemPrompt,
  storyUserPrompt,
} from './prompts.ts';

const StoryJson = z.object({ headline: z.string().min(1), summary: z.string().min(1) });
const OverviewJson = z.object({ overview: z.string().min(1) });

const OVERVIEW_ID = 'overview';
const STORY_PREFIX = 'story:';

/** One batch: a request per multi-source story plus one for the overview. */
export class OpenAiDigestSynthesizer implements DigestSynthesizer {
  readonly #batches: BatchClient;
  readonly #options: ChatModelOptions;
  readonly #price: ModelPrice | undefined;

  /** `price` of `options.model`; usage of a model without one has an unknown cost. */
  constructor(batches: BatchClient, options: ChatModelOptions, price: ModelPrice | undefined) {
    this.#batches = batches;
    this.#options = options;
    this.#price = price;
  }

  submit(request: SynthesisRequest): Promise<string> {
    const stories = request.stories.map((story) => ({
      customId: `${STORY_PREFIX}${story.clusterId}`,
      body: chatRequest(this.#options, {
        system: storySystemPrompt(),
        user: storyUserPrompt(story.items),
        schemaName: 'story',
        schema: STORY_SCHEMA,
      }),
    }));
    const overview =
      request.highlights.length > 0
        ? [
            {
              customId: OVERVIEW_ID,
              body: chatRequest(this.#options, {
                system: overviewSystemPrompt(request.interests),
                user: overviewUserPrompt(request.highlights),
                schemaName: 'overview',
                schema: OVERVIEW_SCHEMA,
              }),
            },
          ]
        : [];
    return this.#batches.submit(request.key, '/v1/chat/completions', [...stories, ...overview]);
  }

  async status(batchRef: string): Promise<BatchState> {
    return toBatchState(await this.#batches.retrieve(batchRef));
  }

  /** Failed answers are dropped: the story keeps its lead headline, the page has no overview. */
  async results(batchRef: string): Promise<SynthesisResults> {
    const batch = await this.#batches.retrieve(batchRef);
    const stories = new Map<string, StoryText>();
    let overview: string | null = null;
    let counts: TokenCounts = { inputTokens: 0, outputTokens: 0 };

    for (const line of await this.#batches.results(batch)) {
      if (line.customId === OVERVIEW_ID) {
        const answer = readChatAnswer(line, OverviewJson);
        counts = addCounts(counts, answer.usage);
        if (answer.ok) overview = answer.value.overview;
      } else if (line.customId.startsWith(STORY_PREFIX)) {
        const answer = readChatAnswer(line, StoryJson);
        counts = addCounts(counts, answer.usage);
        if (answer.ok) stories.set(line.customId.slice(STORY_PREFIX.length), answer.value);
      }
    }
    return { stories, overview, usage: priced(counts, this.#price, batchRef) };
  }
}
