import { randomUUID } from "node:crypto";
import { generateDraft } from "./draft.js";
import {
  newsSettingsSnapshot,
  normalizeNewsSettings,
} from "./news-settings.js";
import { runResearch } from "./research.js";

const ARTICLE_TAGS_FEATURE_KEY = "article_tags";

function featureState(row) {
  return row?.state === "collect" || row?.state === "enabled"
    ? row.state
    : "off";
}

export async function loadArticleTagging({ repository, newsSettings }) {
  const channelId = newsSettings?.channelId ?? null;
  if (!channelId || typeof repository.getNewsFeatureFlags !== "function") {
    return { state: "off", catalog: [] };
  }

  const flags = await repository.getNewsFeatureFlags(channelId);
  const state = featureState(
    flags.find((row) => row.feature_key === ARTICLE_TAGS_FEATURE_KEY),
  );
  if (state === "off") {
    return { state, catalog: [] };
  }
  if (typeof repository.listEnabledArticleTags !== "function") {
    throw new Error("Article tag catalog is unavailable");
  }

  const catalog = await repository.listEnabledArticleTags(
    newsSettings.languageCode,
  );
  if (!catalog.length) {
    throw new Error("No enabled article tags are configured");
  }
  return { state, catalog };
}

export function buildDraftEvidence(selected) {
  const verificationStatus =
    selected.verificationStatus ??
    (selected.unverified
      ? "unverified_community"
      : selected.source.is_primary
        ? "primary_source"
        : "web_source");
  const primaryEvidence = {
    url: selected.canonicalUrl,
    title: selected.title,
    publishedAt: selected.publishedAt,
    text: selected.evidenceText,
    primary: verificationStatus === "primary_source",
    publisher: selected.publisher ?? selected.source.name,
    verificationStatus,
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
      verificationStatus: "unverified_community",
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
  newsSettings,
  editor,
}) {
  const normalizedSettings = normalizeNewsSettings(newsSettings);
  const settingsSnapshot = newsSettingsSnapshot(normalizedSettings);
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
    const articleTagging = await loadArticleTagging({
      repository,
      newsSettings: settingsSnapshot,
    });
    const research = await runResearch({
      repository,
      query,
      keywords,
      windowHours,
      fetchFeedImpl,
      fetchArticleImpl,
      discoveryProvider: aiProvider,
      now,
      newsSettings: settingsSnapshot,
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
      languageCode: normalizedSettings.languageCode,
      newsSettings: settingsSnapshot,
      editor,
      articleTagging,
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
      settings: settingsSnapshot,
      features: {
        articleTags: articleTagging.state,
      },
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
