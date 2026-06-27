import { randomUUID } from "node:crypto";
import { generateDraft } from "./draft.js";
import { runResearch } from "./research.js";

export async function runPipeline({
  repository,
  aiClient,
  model,
  query = "important AI developments",
  keywords = ["AI", "model", "research", "agent"],
  windowHours = 48,
  leaseName = "daily-news-pipeline",
  leaseTtlSeconds = 900,
  ownerId = randomUUID(),
  fetchFeedImpl,
  fetchArticleImpl,
  now,
}) {
  const acquired = await repository.acquirePipelineLease(
    leaseName,
    ownerId,
    leaseTtlSeconds,
  );
  if (!acquired) {
    throw new Error(`Pipeline "${leaseName}" is already running`);
  }

  try {
    const research = await runResearch({
      repository,
      query,
      keywords,
      windowHours,
      fetchFeedImpl,
      fetchArticleImpl,
      now,
    });
    const selected = research.selected;
    const generated = await generateDraft({
      client: aiClient,
      model,
      repository,
      article: selected.article,
      evidence: [
        {
          url: selected.canonicalUrl,
          title: selected.title,
          publishedAt: selected.publishedAt,
          text: selected.evidenceText,
          primary: true,
          publisher: selected.source.name,
        },
      ],
    });

    return {
      runId: research.runId,
      article: selected.article,
      draft: generated.saved,
      preview: generated.draft.telegramText,
      feedErrors: research.feedErrors,
    };
  } finally {
    await repository.releasePipelineLease(leaseName, ownerId);
  }
}
