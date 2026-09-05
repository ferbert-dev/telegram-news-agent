import type {
  CorroborationSearchPort,
  CorroborationSource,
  FactRequest,
} from "./evidence-corroboration.contracts.js";

type AiFactSearch = {
  searchFact: (input: Record<string, unknown>) => Promise<{
    value?: {
      fact?: {
        sourceUrl?: string;
        sourceTitle?: string;
        evidenceText?: string;
      } | null;
    };
  }>;
};

/**
 * Exa, reached through the AI provider cascade this codebase already has.
 *
 * The entire provider-specific surface is these few lines. A different search
 * back end -- Brave, Tavily, a plain HTTP endpoint -- is another file this
 * size, and the corroboration service does not change for any of them.
 *
 * `searchFact` answers with at most one fact, so this yields zero or one
 * source. A provider that returns a list will fill more of the budget per
 * call, which the port allows for and the service already handles.
 */
export function factSearchCorroborationPort(
  provider: AiFactSearch,
): CorroborationSearchPort {
  return {
    async find(
      request: FactRequest,
      context: { languageCode: string; signal?: AbortSignal },
    ): Promise<readonly CorroborationSource[]> {
      const result = await provider.searchFact({
        query: request.query,
        expectedClaim: request.expectedClaim,
        languageCode: context.languageCode,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const fact = result?.value?.fact;
      if (!fact?.sourceUrl) return [];
      return [
        {
          url: fact.sourceUrl,
          title: fact.sourceTitle,
          excerpt: fact.evidenceText,
        },
      ];
    },
  };
}
