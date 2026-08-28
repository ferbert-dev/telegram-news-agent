import { getGeminiConfig } from "../gemini-client.js";
import { exaProviderDescriptor } from "./providers/exa.provider.js";
import { geminiProviderDescriptor } from "./providers/gemini.provider.js";
import { openaiProviderDescriptor } from "./providers/openai.provider.js";

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
  const config = openaiProviderDescriptor.configure(env);
  return config ? openaiProviderDescriptor.createAdapter(config, sdk) : null;
}

export function createGeminiProviderAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk?: GeminiSdkPort,
): AiProviderPort | null {
  const config = geminiProviderDescriptor.configure(env);
  return config ? geminiProviderDescriptor.createAdapter(config, sdk) : null;
}

export function createExaProviderAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk?: ExaSdkPort,
): AiProviderPort | null {
  const config = exaProviderDescriptor.configure(env);
  return config ? exaProviderDescriptor.createAdapter(config, sdk) : null;
}

export function createGeminiClientAdapter(
  env: NodeJS.ProcessEnv = process.env,
  sdk: GeminiSdkPort,
): GeminiClientPort {
  return { client: sdk, model: getGeminiConfig(env).model };
}
