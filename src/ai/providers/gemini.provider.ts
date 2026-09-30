import { GoogleGenAI } from "@google/genai";

import { createGeminiProvider } from "../../gemini-provider.js";
import type { AiProviderPort, GeminiSdkPort } from "../ai-provider.contracts.js";
import type { AiProviderDescriptor } from "./provider-descriptor.contracts.js";

export type GeminiConfig = { apiKey: string; model: string };

export function getTypedGeminiProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeminiConfig | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
  };
}

export const geminiProviderDescriptor: AiProviderDescriptor<GeminiConfig, GeminiSdkPort> = {
  id: "gemini",
  displayName: "Gemini",
  capabilities: ["generateStructured", "searchNews", "searchFeeds", "searchFact"],
  defaultOrderRank: 20,
  traits: {},
  configure: getTypedGeminiProviderConfig,
  createClient: (config) => new GoogleGenAI({ apiKey: config.apiKey }) as GeminiSdkPort,
  createAdapter: (config, client) =>
    createGeminiProvider(config, { client }) as AiProviderPort | null,
};
