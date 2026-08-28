import OpenAI from "openai";

import { createOpenAiProvider, getOpenAiConfig } from "../../openai-provider.js";
import type { AiProviderPort, OpenAiSdkPort } from "../ai-provider.contracts.js";
import type { AiProviderDescriptor } from "./provider-descriptor.contracts.js";

type OpenAiConfig = NonNullable<ReturnType<typeof getOpenAiConfig>>;

export const openaiProviderDescriptor: AiProviderDescriptor<OpenAiConfig, OpenAiSdkPort> = {
  id: "openai",
  displayName: "OpenAI",
  capabilities: ["generateStructured", "searchNews", "searchFeeds", "searchFact"],
  defaultOrderRank: 10,
  traits: {},
  configure: (env) => getOpenAiConfig(env),
  createClient: (config) => new OpenAI({ apiKey: config.apiKey }) as OpenAiSdkPort,
  createAdapter: (config, client) =>
    createOpenAiProvider(config, { client }) as AiProviderPort | null,
};
