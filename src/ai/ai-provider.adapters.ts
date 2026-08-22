import { createGeminiClient, getGeminiConfig } from "../gemini-client.js";
import { createGeminiProvider, getGeminiProviderConfig } from "../gemini-provider.js";
import { createOpenAiProvider, getOpenAiConfig } from "../openai-provider.js";
import { createExaProvider, getExaProviderConfig } from "../exa-provider.js";

import type {
  AiProviderPort,
  ExaSdkPort,
  GeminiClientPort,
  GeminiSdkPort,
  OpenAiSdkPort,
} from "./ai-provider.contracts.js";

export function createOpenAiProviderAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk?: OpenAiSdkPort,
): AiProviderPort | null {
  return createOpenAiProvider(getOpenAiConfig(env), { client: sdk }) as AiProviderPort | null;
}

export function createGeminiProviderAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk?: GeminiSdkPort,
): AiProviderPort | null {
  return createGeminiProvider(getGeminiProviderConfig(env), { client: sdk }) as AiProviderPort | null;
}

export function createExaProviderAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk?: ExaSdkPort,
): AiProviderPort | null {
  return createExaProvider(getExaProviderConfig(env), { client: sdk } as never) as AiProviderPort | null;
}

export function createGeminiClientAdapter(
  env: NodeJS.ProcessEnv = process.env,
): GeminiClientPort {
  return createGeminiClient(getGeminiConfig(env));
}
