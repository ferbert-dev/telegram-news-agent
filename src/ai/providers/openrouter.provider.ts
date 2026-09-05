import OpenAI from "openai";

import type { AiProviderPort, OpenRouterSdkPort } from "../ai-provider.contracts.js";
import {
  createOpenRouterProvider,
  getOpenRouterConfig,
  type OpenRouterConfig,
} from "./openrouter.adapter.js";
import type { AiProviderDescriptor } from "./provider-descriptor.contracts.js";

export const openrouterProviderDescriptor: AiProviderDescriptor<
  OpenRouterConfig,
  OpenRouterSdkPort
> = {
  id: "openrouter",
  displayName: "OpenRouter",
  // generateStructured only. OpenRouter routes text generation; it does not
  // expose the grounded web-search tooling that searchNews, searchFeeds and
  // searchFact depend on, and declaring a capability this adapter cannot serve
  // would put it in the cascade for calls it must then fail.
  capabilities: ["generateStructured"],
  // After OpenAI and Gemini. This routes to other people's models, so it is a
  // fallback for the two first-party providers rather than a peer -- and on
  // the integration stage it exists to be exercised on free models without
  // spending the first-party quotas.
  defaultOrderRank: 30,
  traits: {
    // Absent from the default order unless a key is configured, like Exa. A
    // provider nobody has set up should not appear in the cascade at all.
    includeInDefaultOrderOnlyIfConfigured: true,
    // The legacy JS runtime does not know this provider and deliberately never
    // will: it is part of the migration's target state, and adding it there
    // would grow the surface still to be ported. The drift guard asserts that
    // legacy actually rejects it, so this claim is checked rather than trusted.
    typedRuntimeOnly: true,
    // Well above the cascade's 30s default, because this provider serves FREE
    // endpoints and free endpoints are queued behind paid traffic. At 30s the
    // integration stage saw four attempts in a row time out at exactly the
    // deadline and fall through to a rate-limited OpenAI -- the provider never
    // got the chance to answer, so it cost the wait and delivered nothing.
    //
    // Sized to fit roughly three per-model attempts of 35s, which is what the
    // adapter's walk through the free models actually needs.
    deadlineMs: 120_000,
  },
  configure: (env) => getOpenRouterConfig(env),
  createClient: (config) =>
    new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    }) as OpenRouterSdkPort,
  createAdapter: (config, client) =>
    createOpenRouterProvider(config, {
      client: client as Parameters<typeof createOpenRouterProvider>[1]["client"],
    }) as AiProviderPort | null,
};
