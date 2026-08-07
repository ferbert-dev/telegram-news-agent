import { randomUUID } from "node:crypto";
import { generateDraft } from "./draft.js";
import { runResearch } from "./research.js";

export function buildDraftEvidence(selected) {
  const primaryEvidence = {
    url: selected.canonicalUrl,
    title: selected.title,
    publishedAt: selected.publishedAt,
    text: selected.evidenceText,
    primary: Boolean(selected.source.is_primary),
    publisher: selected.source.name,
  };
  if (
    !selected.unverified ||
    !selected.discoveryUrl ||
    selected.discoveryUrl === selected.canonicalUrl
  ) {
    return [primaryEvidence];
  }
  return [
    primaryEvidence,
    {
      url: selected.discoveryUrl,
      title: `Reddit discussion: ${selected.title}`,
      publishedAt: selected.publishedAt,
      text: selected.evidenceText,
      primary: false,
      publisher: selected.source.name,
    },
  ];
}

export function startPipelineLeaseHeartbeat({
  repository,
  leaseName,
  ownerId,
  leaseTtlSeconds,
  intervalMs = Math.max(1_000, Math.floor((leaseTtlSeconds * 1_000) / 3)),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  let lostError = null;
  let renewal = null;

  const renew = async () => {
    if (renewal || lostError) {
      return renewal;
    }
    renewal = (async () => {
      try {
        const renewed = await repository.renewPipelineLease(
          leaseName,
          ownerId,
          leaseTtlSeconds,
        );
        if (!renewed) {
          lostError = new Error(
            `Pipeline lease "${leaseName}" ownership was lost`,
          );
        }
      } catch (error) {
        lostError = new Error(
          `Pipeline lease "${leaseName}" could not be renewed`,
          { cause: error },
        );
      } finally {
        renewal = null;
      }
    })();
    return renewal;
  };

  const timer = setIntervalImpl(renew, intervalMs);
  timer?.unref?.();

  return {
    assertOwned() {
      if (lostError) {
        throw lostError;
      }
    },
    async stop() {
      clearIntervalImpl(timer);
      await renewal;
      this.assertOwned();
    },
    renew,
  };
}

export async function runPipeline({
  repository,
  aiProvider,
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
  leaseHeartbeatIntervalMs,
  setIntervalImpl,
  clearIntervalImpl,
}) {
  const acquired = await repository.acquirePipelineLease(
    leaseName,
    ownerId,
    leaseTtlSeconds,
  );
  if (!acquired) {
    throw new Error(`Pipeline "${leaseName}" is already running`);
  }

  const heartbeat = startPipelineLeaseHeartbeat({
    repository,
    leaseName,
    ownerId,
    leaseTtlSeconds,
    intervalMs: leaseHeartbeatIntervalMs,
    setIntervalImpl,
    clearIntervalImpl,
  });

  try {
    const research = await runResearch({
      repository,
      query,
      keywords,
      windowHours,
      fetchFeedImpl,
      fetchArticleImpl,
      discoveryProvider: aiProvider,
      now,
    });
    heartbeat.assertOwned();
    const selected = research.selected;
    const generated = await generateDraft({
      aiProvider,
      client: aiClient,
      model,
      repository,
      article: selected.article,
      evidence: buildDraftEvidence(selected),
      allowUnverified: !selected.source.is_primary,
      lease: { name: leaseName, ownerId },
    });
    heartbeat.assertOwned();

    return {
      runId: research.runId,
      article: selected.article,
      draft: generated.saved,
      preview: generated.draft.telegramText,
      provider: generated.provider,
      model: generated.model,
      feedErrors: research.feedErrors,
    };
  } finally {
    let heartbeatError;
    try {
      await heartbeat.stop();
    } catch (error) {
      heartbeatError = error;
    }
    await repository.releasePipelineLease(leaseName, ownerId);
    if (heartbeatError) {
      throw heartbeatError;
    }
  }
}
