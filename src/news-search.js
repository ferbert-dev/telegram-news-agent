import { NoResearchCandidatesError } from "./research.js";

const SEARCH_TIERS = [
  {
    query: "Most important AI development from the last 48 hours",
    windowHours: 48,
  },
  {
    query: "Most important verified AI news or emerging trend from the last 7 days",
    windowHours: 24 * 7,
  },
];

export async function runTieredNewsSearch({
  runWorkflow,
  repository,
  aiClient,
  model,
}) {
  let lastEmptyResult;

  for (const tier of SEARCH_TIERS) {
    try {
      const result = await runWorkflow({
        approvalPolicy: "manual",
        repository,
        aiClient,
        model,
        query: tier.query,
        keywords: [
          "AI",
          "model",
          "research",
          "agent",
          "release",
          "benchmark",
          "open source",
        ],
        windowHours: tier.windowHours,
      });
      return { result, tier };
    } catch (error) {
      if (!(error instanceof NoResearchCandidatesError)) {
        throw error;
      }
      lastEmptyResult = error;
    }
  }

  throw lastEmptyResult;
}
