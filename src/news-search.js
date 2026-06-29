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

export async function runCheckpointedNewsSearch({
  updateId,
  repository,
  aiClient,
  model,
  runWorkflow,
}) {
  const existing = await repository.getTelegramNewsCheckpoint(updateId);
  if (existing) {
    return {
      status: existing.status,
      draftId: existing.draft_id,
      preview: existing.preview,
      windowHours: existing.window_hours,
      resumed: true,
    };
  }

  try {
    const { result, tier } = await runTieredNewsSearch({
      runWorkflow,
      repository,
      aiClient,
      model,
    });
    const checkpoint = await repository.saveTelegramNewsCheckpoint({
      update_id: updateId,
      status: "review_ready",
      draft_id: result.draft.id,
      preview: result.preview,
      window_hours: tier.windowHours,
      updated_at: new Date().toISOString(),
    });
    return {
      status: checkpoint.status,
      draftId: checkpoint.draft_id,
      preview: checkpoint.preview,
      windowHours: checkpoint.window_hours,
      resumed: false,
    };
  } catch (error) {
    if (!(error instanceof NoResearchCandidatesError)) {
      throw error;
    }
    const checkpoint = await repository.saveTelegramNewsCheckpoint({
      update_id: updateId,
      status: "no_candidates",
      draft_id: null,
      preview: null,
      window_hours: null,
      updated_at: new Date().toISOString(),
    });
    return {
      status: checkpoint.status,
      draftId: null,
      preview: null,
      windowHours: null,
      resumed: false,
    };
  }
}
