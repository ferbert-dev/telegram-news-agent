import { Exa } from "exa-js";

import { createExaProvider, getExaProviderConfig } from "../../exa-provider.js";
import type { AiProviderPort, ExaSdkPort } from "../ai-provider.contracts.js";
import type { AiProviderDescriptor } from "./provider-descriptor.contracts.js";

type ExaConfig = NonNullable<ReturnType<typeof getExaProviderConfig>>;

export const exaProviderDescriptor: AiProviderDescriptor<ExaConfig, ExaSdkPort> = {
  id: "exa",
  displayName: "Exa",
  capabilities: ["searchNews", "searchFeeds", "searchFact"],
  defaultOrderRank: 0,
  traits: {
    haltsCascadeOnQuotaExhaustion: true,
    exclusiveOperations: ["searchFact"],
    sequentialOperations: ["searchFact"],
    supportsConnectionTest: true,
    includeInDefaultOrderOnlyIfConfigured: true,
  },
  configure: (env) => getExaProviderConfig(env),
  createClient: (config) => new Exa(config.apiKey) as ExaSdkPort,
  createAdapter: (config, client) =>
    createExaProvider(config, { client } as never) as AiProviderPort | null,
};
