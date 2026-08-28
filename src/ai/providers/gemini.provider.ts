import { GoogleGenAI } from "@google/genai";

import { createGeminiProvider, getGeminiProviderConfig } from "../../gemini-provider.js";
import type { AiProviderPort, GeminiSdkPort } from "../ai-provider.contracts.js";
import type { AiProviderDescriptor } from "./provider-descriptor.contracts.js";

type GeminiConfig = NonNullable<ReturnType<typeof getGeminiProviderConfig>>;

export const geminiProviderDescriptor: AiProviderDescriptor<GeminiConfig, GeminiSdkPort> = {
  id: "gemini",
  displayName: "Gemini",
  capabilities: ["generateStructured", "searchNews", "searchFeeds", "searchFact"],
  defaultOrderRank: 20,
  traits: {},
  configure: (env) => getGeminiProviderConfig(env),
  createClient: (config) => new GoogleGenAI({ apiKey: config.apiKey }) as GeminiSdkPort,
  createAdapter: (config, client) =>
    createGeminiProvider(config, { client }) as AiProviderPort | null,
};
