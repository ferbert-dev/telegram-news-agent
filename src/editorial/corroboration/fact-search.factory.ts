import { createHash } from "node:crypto";
import { Exa } from "exa-js";

import { exaUsageEvent } from "../../ai-usage.js";
import { getExaProviderConfig } from "../../exa-provider.js";
import type { CorroborationSearchPort } from "./evidence-corroboration.contracts.js";
import { exaFactSearchPort } from "./exa-fact-search.adapter.js";

/**
 * Builds the corroboration search port when Exa is configured, and nothing
 * otherwise, so the caller falls back to the provider cascade.
 *
 * Reads the existing Exa configuration rather than introducing a second way to
 * configure the same provider, exactly as the article-content factory does:
 * EXA_ENABLED and EXA_API_KEY already gate it, and a separate switch would be
 * a way for the two to disagree.
 *
 * The daily ceiling reuses EXA_DAILY_SEARCH_CAP. Corroboration search, content
 * retrieval and the legacy provider's own searches all bill against one
 * account, and they are counted separately here -- so the effective spend is a
 * multiple of the number the name suggests. Worth a dedicated setting; worth
 * not being silently uncapped now.
 */
export function buildCorroborationSearchPort(
  env: NodeJS.ProcessEnv = process.env,
): CorroborationSearchPort | null {
  const config = getExaProviderConfig(env) as
    | { apiKey: string; dailySearchCap: number; searchType?: string; maxResults?: number; model?: string }
    | null;
  if (!config) return null;
  return exaFactSearchPort(new Exa(config.apiKey) as never, {
    dailyCap: config.dailySearchCap,
    quotaKey: createHash("sha256").update(config.apiKey).digest("hex"),
    ...(config.searchType ? { searchType: config.searchType } : {}),
    ...(config.maxResults ? { maxResults: Math.min(8, config.maxResults) } : {}),
    ...(config.model ? { model: config.model } : {}),
    usageEvent: exaUsageEvent as never,
  });
}
