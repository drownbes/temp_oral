import OpenAI from 'openai';
import type { AppConfig } from '../config.ts';

/** One client per process; undefined unless the LLM provider is OpenAI. */
export function createOpenAiClient(config: AppConfig): OpenAI | undefined {
  if (config.llm.provider !== 'openai') return undefined;
  return new OpenAI({ apiKey: config.llm.openaiApiKey, maxRetries: 3 });
}
