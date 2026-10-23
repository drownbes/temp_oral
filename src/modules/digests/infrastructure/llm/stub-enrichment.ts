import type {
  BatchState,
  DigestSynthesizer,
  EmbeddingRequest,
  EmbeddingResults,
  ItemEmbedder,
  SynthesisRequest,
  SynthesisResults,
} from '../../application/ports.ts';
import { NO_USAGE } from '../../domain/digest.ts';
import type { StoryText } from '../../domain/story.ts';

const DIMENSIONS = 256;
const STOP_WORDS = new Set(
  'the and for with from that this into are was has have its new now out more than via over'.split(
    ' ',
  ),
);

/**
 * Development stand-in (LLM_PROVIDER=stub): a hashed bag of words of the title, so items
 * with near-identical titles from different sources land close together and cluster.
 * Batches live in memory, like the stub analyzer.
 */
export class StubItemEmbedder implements ItemEmbedder {
  readonly #batches = new Map<string, EmbeddingRequest>();

  async submit(request: EmbeddingRequest): Promise<string> {
    const ref = `stub-${request.key}`;
    this.#batches.set(ref, request);
    return ref;
  }

  async status(): Promise<BatchState> {
    return { state: 'completed' };
  }

  async results(batchRef: string): Promise<EmbeddingResults> {
    const embeddings = new Map<string, readonly number[]>();
    for (const item of this.#batches.get(batchRef)?.items ?? []) {
      embeddings.set(item.itemId, bagOfWords(item.title));
    }
    return { embeddings, usage: NO_USAGE };
  }
}

/** Headline = the first item's title; overview = the highlight titles. */
export class StubDigestSynthesizer implements DigestSynthesizer {
  readonly #batches = new Map<string, SynthesisRequest>();

  async submit(request: SynthesisRequest): Promise<string> {
    const ref = `stub-${request.key}`;
    this.#batches.set(ref, request);
    return ref;
  }

  async status(): Promise<BatchState> {
    return { state: 'completed' };
  }

  async results(batchRef: string): Promise<SynthesisResults> {
    const request = this.#batches.get(batchRef);
    const stories = new Map<string, StoryText>();
    for (const story of request?.stories ?? []) {
      const sources = story.items.map((i) => i.sourceName).join(', ');
      stories.set(story.clusterId, {
        headline: `[stub] ${story.items[0]?.title ?? ''}`,
        summary: `[stub] Covered by ${sources}.`,
      });
    }
    const titles = (request?.highlights ?? []).slice(0, 3).map((h) => h.title);
    const overview = titles.length ? `[stub] Today: ${titles.join('; ')}.` : null;
    return { stories, overview, usage: NO_USAGE };
  }
}

function bagOfWords(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9.]+/g) ?? [];
  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
  }
  return vector;
}
