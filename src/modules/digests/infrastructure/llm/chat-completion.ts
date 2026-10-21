import { z } from 'zod';
import type { TokenUsage } from '../../domain/digest.ts';
import type { BatchResultLine } from './openai-batch-client.ts';

export interface ChatModelOptions {
  readonly model: string;
  /** Sent as `reasoning_effort` when set (reasoning models only). */
  readonly reasoningEffort: string | undefined;
}

/** A /v1/chat/completions body asking for strict structured output. */
export function chatRequest(
  options: ChatModelOptions,
  prompt: { system: string; user: string; schemaName: string; schema: object },
) {
  return {
    model: options.model,
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: prompt.schemaName, strict: true, schema: prompt.schema },
    },
  };
}

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

export type ChatAnswer<T> =
  | { readonly ok: true; readonly value: T; readonly usage: TokenUsage }
  | { readonly ok: false; readonly failure: string; readonly usage: TokenUsage };

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/** Reads one batch result line as a JSON answer; every kind of bad answer becomes a failure. */
export function readChatAnswer<T>(line: BatchResultLine, schema: z.ZodType<T>): ChatAnswer<T> {
  if (line.error) return { ok: false, failure: line.error, usage: NO_USAGE };
  const parsed = ChatCompletionBody.safeParse(line.body);
  if (!parsed.success) return { ok: false, failure: 'unexpected response shape', usage: NO_USAGE };

  const usage = {
    inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
    outputTokens: parsed.data.usage?.completion_tokens ?? 0,
  };
  const [choice] = parsed.data.choices;
  if (!choice) return { ok: false, failure: 'no choices in response', usage };
  if (choice.message.refusal) {
    return { ok: false, failure: `refused: ${choice.message.refusal}`, usage };
  }
  if (choice.finish_reason === 'length') {
    return { ok: false, failure: 'answer cut off (token limit)', usage };
  }
  try {
    return { ok: true, value: schema.parse(JSON.parse(choice.message.content ?? '')), usage };
  } catch {
    return { ok: false, failure: 'malformed JSON answer', usage };
  }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
