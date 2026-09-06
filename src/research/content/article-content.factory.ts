import { Exa } from "exa-js";
import { createHash } from "node:crypto";

import { getExaProviderConfig } from "../../exa-provider.js";
import type { ArticleContentPort } from "./article-content.contracts.js";
import { exaArticleContentPort } from "./exa-article-content.adapter.js";

/**
 * Builds the content port when the environment has Exa set up, and nothing
 * otherwise.
 *
 * Reads the existing Exa configuration rather than introducing a second way to
 * configure the same provider: EXA_ENABLED and EXA_API_KEY already gate it, and
 * a separate switch would be a way for the two to disagree.
 *
 * The daily ceiling reuses EXA_DAILY_SEARCH_CAP. Content retrieval and search
 * bill against the same account, so one budget covering both is the honest
 * reading -- though they are counted separately, which means the effective
 * spend is up to twice the number the name suggests. Worth a dedicated setting
 * later; worth not being silently uncapped now.
 */
export function buildArticleContentPort(
  env: NodeJS.ProcessEnv = process.env,
): ArticleContentPort | null {
  const config = getExaProviderConfig(env) as
    | { apiKey: string; dailySearchCap: number }
    | null;
  if (!config) return null;
  return exaArticleContentPort(new Exa(config.apiKey) as never, {
    dailyCap: config.dailySearchCap,
    // The key never leaves this file; the counter is keyed by its digest, the
    // same way the search cap keys its own.
    quotaKey: createHash("sha256").update(config.apiKey).digest("hex"),
  });
}
