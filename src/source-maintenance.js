import { createHash } from "node:crypto";
import { assertPublicHttpUrl } from "./feed.js";
import { recordAiUsageEvents } from "./ai-usage.js";

const MAX_DISCOVERED_FEEDS = 8;

function normalizedLabels(values) {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

export function sourceDiscoveryKey(settings = {}) {
  const scope = JSON.stringify({
    topicCodes: normalizedLabels(settings.topicCodes),
    customTopics: normalizedLabels(settings.customTopics),
  });
  return createHash("sha256").update(scope).digest("hex");
}

export function classifySourceFetchError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  const httpStatus = message.match(/http\s+(\d{3})/i)?.[1];
  if (httpStatus) return `http_${httpStatus}`;
  if (error?.name === "AbortError" || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("unsupported feed") || message.includes("expected rss")) {
    return "invalid_feed";
  }
  if (message.includes("exceeds") && message.includes("bytes")) {
    return "response_too_large";
  }
  if (message.includes("private") || message.includes("public http")) {
    return "unsafe_url";
  }
  return "fetch_failed";
}

export async function markSourceFetchSuccess(repository, sourceId) {
  if (!sourceId) return null;
  if (typeof repository.markSourceFetchSuccess === "function") {
    return repository.markSourceFetchSuccess(sourceId);
  }
  return repository.markSourceChecked?.(sourceId) ?? null;
}

export async function markSourceFetchFailure(repository, sourceId, error) {
  if (!sourceId || typeof repository.markSourceFetchFailure !== "function") {
    return null;
  }
  return repository.markSourceFetchFailure(
    sourceId,
    classifySourceFetchError(error),
  );
}

function safeDiscoveryError(error) {
  const code = String(error?.code ?? "source_discovery_failed")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 64);
  return code.length >= 2 ? code : "source_discovery_failed";
}

function discoveryHomepage(feedUrl, homepageUrl) {
  if (homepageUrl) {
    return assertPublicHttpUrl(homepageUrl).toString();
  }
  return new URL(feedUrl).origin;
}

function normalizedFeedUrl(value) {
  const url = assertPublicHttpUrl(value);
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

export async function discoverNewFeedSources({
  repository,
  aiProvider,
  newsSettings,
  fetchFeedImpl,
  retryImpl,
  searchRunId,
}) {
  if (
    typeof aiProvider?.searchFeeds !== "function" ||
    typeof repository?.claimSourceDiscovery !== "function" ||
    typeof repository?.completeSourceDiscovery !== "function" ||
    typeof repository?.upsertDiscoveredSource !== "function"
  ) {
    return { status: "unsupported", sources: [], usageEvents: [] };
  }

  const topicKey = sourceDiscoveryKey(newsSettings);
  const claimed = await repository.claimSourceDiscovery(topicKey);
  if (!claimed) {
    return { status: "cooldown", topicKey, sources: [], usageEvents: [] };
  }

  let provider = null;
  let model = null;
  try {
    const discovery = await aiProvider.searchFeeds({
      topicCodes: [...(newsSettings?.topicCodes ?? [])],
      customTopics: [...(newsSettings?.customTopics ?? [])],
      languageCode: newsSettings?.languageCode ?? "en",
      limit: MAX_DISCOVERED_FEEDS,
    });
    provider = discovery.provider ?? null;
    model = discovery.model ?? null;
    if (!new Set(["openai", "gemini", "exa"]).has(provider)) {
      throw new Error("Feed discovery returned an unsupported provider");
    }
    await recordAiUsageEvents(repository, discovery.usageEvents, {
      channelId: newsSettings?.channelId ?? null,
      searchRunId,
    });

    const sources = [];
    const failures = [];
    const seen = new Set();
    for (const item of discovery.items ?? []) {
      let feedUrl;
      try {
        feedUrl = normalizedFeedUrl(item.feedUrl);
        if (seen.has(feedUrl)) continue;
        seen.add(feedUrl);
        const entries = await retryImpl(() => fetchFeedImpl(feedUrl), {
          attempts: 2,
          baseDelayMs: 500,
        });
        if (!entries.length) {
          throw new Error("Validated feed contains no entries");
        }
        const homepageUrl = discoveryHomepage(feedUrl, item.homepageUrl);
        const saved = await repository.upsertDiscoveredSource({
          name: item.name,
          homepageUrl,
          feedUrl,
          reliabilityScore: 65,
          topicCodes: [...(newsSettings?.topicCodes ?? [])],
          discoveredBy: provider,
          discoveryMetadata: {
            custom_topics: [...(newsSettings?.customTopics ?? [])],
            language_code: newsSettings?.languageCode ?? "en",
            discovered_at: new Date().toISOString(),
          },
        });
        sources.push({
          source: {
            ...saved,
            topic_codes: [...(newsSettings?.topicCodes ?? [])],
          },
          entries,
        });
      } catch (error) {
        failures.push({
          feed_url: feedUrl ?? String(item.feedUrl ?? ""),
          error_code: classifySourceFetchError(error),
        });
      }
    }

    await repository.completeSourceDiscovery({
      topicKey,
      provider,
      model,
      resultCount: sources.length,
      errorCode: null,
    });
    return {
      status: "completed",
      topicKey,
      provider,
      model,
      sources,
      failures,
      usageEvents: discovery.usageEvents ?? [],
    };
  } catch (error) {
    const errorCode = safeDiscoveryError(error);
    await repository.completeSourceDiscovery({
      topicKey,
      provider,
      model,
      resultCount: 0,
      errorCode,
    });
    return {
      status: "failed",
      topicKey,
      provider,
      model,
      sources: [],
      failures: [],
      error: errorCode,
      usageEvents: [],
    };
  }
}
