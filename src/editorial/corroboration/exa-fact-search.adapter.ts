import type {
  CorroborationSearchPort,
  CorroborationSearchResult,
  CorroborationSource,
  FactRequest,
} from "./evidence-corroboration.contracts.js";
import { tierOf } from "./source-policy.js";

export class ExaDailyFactSearchCapError extends Error {
  readonly code = "exa_daily_fact_search_cap";
  constructor(cap: number) {
    super(`Exa daily fact-search cap of ${cap} calls was reached`);
    this.name = "ExaDailyFactSearchCapError";
  }
}

type DailyCallStore = {
  get(key: string): { date: string; calls: number } | undefined;
  set(key: string, value: { date: string; calls: number }): void;
};

const PROCESS_DAILY_SEARCH_USAGE = new Map<
  string,
  { date: string; calls: number }
>();

type ExaSearchClient = {
  search: (
    query: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    requestId?: string;
    results?: Array<{
      url?: string;
      title?: string;
      text?: string;
      highlights?: string[];
      publishedDate?: string;
    }>;
  }>;
};

/**
 * Corroboration search against Exa, returning everything it found.
 *
 * This exists because the equivalent in the frozen `src/exa-provider.js` does
 * two things that cost the feature its entire value, and it cannot be changed
 * there:
 *
 *   1. It drops every result whose host is not one of about forty domains.
 *   2. It `return`s inside the loop, so at most ONE result survives per search.
 *
 * Measured on the integration stage: three paid searches for a Miami runway
 * crash produced fifteen candidates -- a story covered by the Miami Herald,
 * CNN, NBC and local broadcasters -- and the published article cited exactly
 * one source, the one it started with. Both halves of that are fixed here:
 * every result comes back, and each carries a tier so the service can tell
 * "this may lift the caveat" from "the article may use this".
 *
 * Judging a source is the policy's job, not this adapter's. Another search
 * provider is another file this size and no change anywhere else.
 */
export function exaFactSearchPort(
  client: ExaSearchClient,
  {
    dailyCap,
    quotaKey,
    searchType = "auto",
    maxResults = 5,
    model = "exa-search",
    capStore = PROCESS_DAILY_SEARCH_USAGE,
    now = () => new Date(),
    usageEvent,
  }: {
    dailyCap: number;
    quotaKey: string;
    searchType?: string;
    maxResults?: number;
    model?: string;
    capStore?: DailyCallStore;
    now?: () => Date;
    /**
     * Builds the ledger entry for one call. Injected so this file does not
     * import the legacy usage helper -- the composition root supplies it, the
     * same seam the article-content port uses.
     */
    usageEvent: (response: unknown, context: { model: string; operation: string }) => unknown;
  },
): CorroborationSearchPort {
  const reserve = () => {
    const date = now().toISOString().slice(0, 10);
    const current = capStore.get(quotaKey);
    const calls = current?.date === date ? current.calls : 0;
    if (calls >= dailyCap) throw new ExaDailyFactSearchCapError(dailyCap);
    capStore.set(quotaKey, { date, calls: calls + 1 });
  };

  return {
    async find(
      request: FactRequest,
      _context: { languageCode: string; signal?: AbortSignal },
    ): Promise<CorroborationSearchResult> {
      reserve();
      const query = `${request.query} ${request.expectedClaim}`.slice(0, 900).trim();
      const response = await client.search(query, {
        type: searchType,
        numResults: maxResults,
        contents: {
          text: { maxCharacters: 2_000 },
          highlights: { query },
        },
      });

      const sources: CorroborationSource[] = [];
      const seen = new Set<string>();
      for (const result of response?.results ?? []) {
        const url = typeof result?.url === "string" ? result.url : "";
        const tier = url ? tierOf(url) : null;
        if (!url || !tier || seen.has(url)) continue;
        // The highlight is the passage Exa judged relevant to the query; the
        // body is the fallback. Either is material the model can write from,
        // and neither has to survive a substring comparison any more.
        const excerpt =
          result.highlights?.find((highlight) => Boolean(highlight?.trim()))
          ?? result.text?.slice(0, 800)
          ?? "";
        if (!excerpt.trim()) continue;
        seen.add(url);
        sources.push({
          url,
          ...(result.title ? { title: result.title } : {}),
          excerpt,
          tier,
          publishedAt: result.publishedDate ?? null,
        });
      }

      return {
        sources,
        usageEvents: [
          usageEvent(response, { model, operation: "searchFact" }),
        ],
      };
    },
  };
}
