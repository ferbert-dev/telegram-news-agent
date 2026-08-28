import { getGeminiConfig } from "../gemini-client.js";
import { openaiProviderDescriptor } from "./providers/openai.provider.js";

import type {
  AiProviderPort,
  GeminiClientPort,
  GeminiSdkPort,
  OpenAiSdkPort,
} from "./ai-provider.contracts.js";

// Kept for checks/emitted-ai-provider-core.mjs, which asserts this survives
// tsc emit. Gemini's and Exa's equivalents were dropped: nothing calls them
// — src/ai/ai-providers.module.ts builds their adapters straight from the
// descriptors in providers/gemini.provider.ts and providers/exa.provider.ts.
export function createOpenAiProviderAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk?: OpenAiSdkPort,
): AiProviderPort | null {
  const config = openaiProviderDescriptor.configure(env);
  return config ? openaiProviderDescriptor.createAdapter(config, sdk) : null;
}

export function createGeminiClientAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk: GeminiSdkPort,
): GeminiClientPort {
  return { client: sdk, model: getGeminiConfig(env).model };
}
