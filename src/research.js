import { fetchArticle } from "./article-extractor.js";
import {
  assertPublicHttpUrl,
  canonicalizeUrl,
  fetchFeed,
  hashText,
} from "./feed.js";
import { fetchRedditDiscoveries } from "./reddit.js";
import { fetchGdeltDiscoveries } from "./gdelt.js";
import { curateNewsCandidates } from "./news-curation.js";
import { recordAiUsageEvents } from "./ai-usage.js";
import {
  discoverNewFeedSources,
  markSourceFetchFailure,
  markSourceFetchSuccess,
} from "./source-maintenance.js";
import {
  newsSettingsSnapshot,
  normalizeNewsSettings,
} from "./news-settings.js";
import { withRetry } from "./retry.js";
import { evaluateStoryDuplicate } from "./story-deduplication.js";
import {
  applyExcludedTopicPolicy,
  excludedTopicDefinitions,
  EXCLUDED_TOPIC_POLICY_PROMPT_VERSION,
} from "./excluded-topic-policy.js";

const HOUR_MS = 60 * 60 * 1000;
const FEED_CONCURRENCY = 8;
const MAX_ENTRIES_PER_FEED = 40;
const MAX_PERSISTED_CANDIDATES = 80;
const STORY_HISTORY_DAYS = 14;
const MAX_STORY_HISTORY = 100;
const MAX_SEMANTIC_STORY_AI_CALLS = 3;

export class NoResearchCandidatesError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoResearchCandidatesError";
  }
}

function keywordScore(candidate, keywords) {
  if (!keywords.length) {
    return 0;
  }

  const haystack = `${candidate.title} ${candidate.summary}`.toLowerCase();
  const matches = keywords.filter((keyword) =>
    haystack.includes(keyword.toLowerCase()),
  ).length;

  return Math.min(20, matches * 5);
}

function sourceHostname(source) {
  for (const value of [source.homepage_url, source.feed_url]) {
    try {
      if (value) {
        return new URL(value).hostname.toLowerCase();
      }
    } catch {
      // Invalid source URLs are rejected by the source registry.
    }
  }
  return null;
}

function webSourceForUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return {
    id: null,
    name: hostname.replace(/^www\./, ""),
    homepage_url: url.origin,
    feed_url: null,
    source_type: "website",
    reliability_score: 80,
    is_primary: false,
  };
}

function sourceMatchesSettings(source, settings) {
  if (!settings) {
    return true;
  }
  const sourceTopicCodes = source.topic_codes ?? source.topicCodes;
  if (
    Array.isArray(sourceTopicCodes) &&
    sourceTopicCodes.some((code) => settings.topicCodes.includes(code))
  ) {
    return true;
  }
  const discoveredTopics = source.discovery_metadata?.custom_topics;
  if (Array.isArray(discoveredTopics) && settings.customTopics.length) {
    const selected = new Set(
      settings.customTopics.map((topic) => topic.trim().toLowerCase()),
    );
    if (
      discoveredTopics.some((topic) =>
        selected.has(String(topic).trim().toLowerCase()),
      )
    ) {
      return true;
    }
  }
  if (Array.isArray(sourceTopicCodes) && sourceTopicCodes.length) {
    return false;
  }
  // Existing static RSS/API sources are AI-specific. Untagged sources are
  // therefore eligible only when AI is one of the selected subjects.
  return settings.topicCodes.includes("ai");
}

function sourceUsesHost(source, expectedHost) {
  try {
    return new URL(source.feed_url).hostname.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

function newestFeedEntries(entries, limit = MAX_ENTRIES_PER_FEED) {
  return [...entries]
    .sort((left, right) => {
      const leftTime = Date.parse(left.publishedAt ?? "") || 0;
      const rightTime = Date.parse(right.publishedAt ?? "") || 0;
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

async function mapSettledWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = {
          status: "fulfilled",
          value: await operation(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      worker,
    ),
  );
  return results;
}

export function matchPrimarySource(url, sources) {
  const hostname = new URL(url).hostname.toLowerCase();
  return sources.find((source) => {
    const sourceHost = sourceHostname(source);
    return (
      sourceHost &&
      (hostname === sourceHost || hostname.endsWith(`.${sourceHost}`))
    );
  });
}

export function scoreCandidate(
  candidate,
  source,
  { now = new Date(), keywords = [], windowHours = 48 } = {},
) {
  const reliability = source.reliability_score ?? 50;
  const publishedAt = candidate.publishedAt
    ? new Date(candidate.publishedAt)
    : null;
  const ageHours =
    publishedAt && !Number.isNaN(publishedAt.valueOf())
      ? Math.max(0, (now.valueOf() - publishedAt.valueOf()) / HOUR_MS)
      : 72;
  // Recency spans the full 0-30 across whatever window is being searched,
  // rather than across a fixed 48 hours.
  //
  // The constant 0.625 was 30/48: recency decayed to zero exactly at the edge
  // of the only window that existed. With a 24-hour tier that constant becomes
  // wrong in the direction that matters -- an article at the edge of the
  // window would still score 15 of 30, so half the freshness signal would be
  // spent on articles the tier was created to rank below fresher ones.
  //
  // Deriving the slope from the window is identical at 48 hours
  // (30 * (1 - age/48) === 30 - age * 0.625, asserted in test/research.test.js)
  // and correct at every other window.
  const span =
    Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 48;
  const recency = Math.max(0, 30 * (1 - ageHours / span));
  const primary = source.is_primary ? 30 : 0;

  const discovery =
    candidate.discoveryKind === "reddit"
      ? 5
      : candidate.discoveryKind?.endsWith("_web_search")
        ? Math.max(20, 40 - (candidate.searchRank ?? 0) * 4)
        : 0;

  return Number(
    (
      reliability * 0.2 +
      recency +
      primary +
      keywordScore(candidate, keywords) +
      discovery
    ).toFixed(3),
  );
}

export function rankCandidates(
  candidates,
  { now = new Date(), keywords = [], windowHours = 48 } = {},
) {
  const cutoff = now.valueOf() - windowHours * HOUR_MS;
  const unique = new Map();

  for (const candidate of candidates) {
    const publishedAt = candidate.publishedAt
      ? new Date(candidate.publishedAt).valueOf()
      : Number.NaN;

    if (!Number.isNaN(publishedAt) && publishedAt < cutoff) {
      continue;
    }

    const existing = unique.get(candidate.canonicalUrl);
    const scored = {
      ...candidate,
      score: scoreCandidate(candidate, candidate.source, {
        now,
        keywords,
        windowHours,
      }),
    };

    if (!existing || scored.score > existing.score) {
      unique.set(candidate.canonicalUrl, scored);
    }
  }

  return [...unique.values()].sort(
    (left, right) =>
      right.score - left.score ||
      (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
      left.canonicalUrl.localeCompare(right.canonicalUrl),
  );
}

export async function runResearch({
  repository,
  query,
  keywords = [],
  windowHours = 48,
  fetchFeedImpl = fetchFeed,
  fetchRedditImpl = fetchRedditDiscoveries,
  fetchGdeltImpl = fetchGdeltDiscoveries,
  fetchArticleImpl = fetchArticle,
  discoveryProvider,
  retryImpl = withRetry,
  now = new Date(),
  newsSettings,
  log = console,
}) {
  const normalizedSettings = newsSettings
    ? normalizeNewsSettings(newsSettings)
    : null;
  const settingsSnapshot = normalizedSettings
    ? newsSettingsSnapshot(normalizedSettings)
    : null;
  const excludedTopicCodes = normalizedSettings?.excludedTopicCodes ?? [];
  const run = await repository.startSearchRun({
    query,
    metadata: {
      keywords,
      window_hours: windowHours,
      news_settings: settingsSnapshot,
    },
  });
  let terminalRunRecorded = false;

  try {
    const excludedTopicAudits = [];
    const recordExcludedTopicPolicy = async (
      policyResult,
      { articleId = null } = {},
    ) => {
      excludedTopicAudits.push(policyResult.audit);
      await recordAiUsageEvents(repository, policyResult.usageEvents, {
        channelId: normalizedSettings?.channelId ?? null,
        searchRunId: run.id,
        articleId,
      });
      if (
        policyResult.audit.enabled &&
        (policyResult.audit.blockedCount > 0 ||
          policyResult.audit.semanticClassifiedCount > 0)
      ) {
        try {
          log.info?.(
            JSON.stringify({
              event: "excluded_topic_policy",
              ...policyResult.audit,
            }),
          );
        } catch {
          // Observability is best-effort and must not alter policy decisions.
        }
      }
      return policyResult;
    };
    const applyPolicy = async (
      candidates,
      stage,
      context = {},
    ) =>
      recordExcludedTopicPolicy(
        await applyExcludedTopicPolicy({
          candidates,
          excludedTopicCodes,
          aiProvider: discoveryProvider,
          stage,
        }),
        context,
      );
    const excludedTopicPolicySummary = () => {
      const enabledAudits = excludedTopicAudits.filter(
        (audit) => audit.enabled,
      );
      const acquisitionAudits = enabledAudits.filter(
        (audit) => audit.stage !== "selected_evidence",
      );
      const evidenceAudits = enabledAudits.filter(
        (audit) => audit.stage === "selected_evidence",
      );
      const providers = new Map();
      for (const audit of enabledAudits) {
        for (const provider of audit.providers) {
          const key = `${provider.provider ?? "unknown"}\u0000${provider.model ?? "unknown"}`;
          providers.set(key, provider);
        }
      }
      const sum = (audits, field) =>
        audits.reduce((total, audit) => total + Number(audit[field] ?? 0), 0);
      return {
        enabled: excludedTopicCodes.length > 0,
        policy_codes: [...excludedTopicCodes],
        prompt_version: EXCLUDED_TOPIC_POLICY_PROMPT_VERSION,
        input_count: sum(acquisitionAudits, "inputCount"),
        eligible_count: sum(acquisitionAudits, "eligibleCount"),
        blocked_count: sum(acquisitionAudits, "blockedCount"),
        deterministic_blocked_count: sum(
          acquisitionAudits,
          "deterministicBlockedCount",
        ),
        semantic_classified_count: sum(
          acquisitionAudits,
          "semanticClassifiedCount",
        ),
        evidence_checked_count: sum(evidenceAudits, "inputCount"),
        evidence_blocked_count: sum(evidenceAudits, "blockedCount"),
        usage_event_count: sum(enabledAudits, "usageEventCount"),
        providers: [...providers.values()],
        stages: enabledAudits.map((audit) => ({
          stage: audit.stage,
          input_count: audit.inputCount,
          eligible_count: audit.eligibleCount,
          blocked_count: audit.blockedCount,
          deterministic_blocked_count: audit.deterministicBlockedCount,
          semantic_classified_count: audit.semanticClassifiedCount,
          semantic_blocked_count: audit.semanticBlockedCount,
          prompt_version: audit.promptVersion,
          providers: audit.providers,
          usage_event_count: audit.usageEventCount,
        })),
      };
    };
    const finishPolicyFilteredSearchRun = async (terminalStage) => {
      await repository.finishSearchRun(run.id, {
        resultCount: 0,
        metadata: {
          status: "no_candidates",
          reason: "excluded_topic_policy",
          terminal_stage: terminalStage,
          excluded_topic_policy: excludedTopicPolicySummary(),
          news_settings: settingsSnapshot,
        },
      });
      terminalRunRecorded = true;
    };
    const sources = await repository.listEnabledSources();
    const primarySources = sources.filter((source) => source.is_primary);
    const rssSources = sources.filter(
      (source) =>
        source.source_type === "rss" &&
        sourceMatchesSettings(source, normalizedSettings),
    );
    const redditSources = sources.filter(
      (source) =>
        !source.is_primary &&
        sourceMatchesSettings(source, normalizedSettings) &&
        source.source_type === "api" &&
        source.feed_url &&
        new URL(source.feed_url).hostname.endsWith("reddit.com"),
    );
    const gdeltSources = sources.filter(
      (source) =>
        !source.is_primary &&
        (sourceMatchesSettings(source, normalizedSettings) ||
          Boolean(normalizedSettings?.customTopics.length)) &&
        source.source_type === "api" &&
        source.feed_url &&
        sourceUsesHost(source, "api.gdeltproject.org"),
    );

    if (
      !rssSources.length &&
      !gdeltSources.length &&
      !discoveryProvider?.searchFeeds &&
      !discoveryProvider?.searchNews
    ) {
      throw new Error("No enabled news discovery sources are configured");
    }

    const settled = await mapSettledWithConcurrency(
      rssSources,
      FEED_CONCURRENCY,
      async (source) => {
        const entries = await retryImpl(
          () => fetchFeedImpl(source.feed_url),
          { attempts: 3, baseDelayMs: 300 },
        );
        await markSourceFetchSuccess(repository, source.id);
        return newestFeedEntries(entries).map((entry) => ({
          ...entry,
          source,
          publisher: source.name,
          discoveryKind: source.is_primary ? "primary_feed" : "rss_feed",
        }));
      },
    );
    const directCandidates = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const redditSettled = await Promise.allSettled(
      redditSources.map(async (source) => {
        const entries = await retryImpl(
          () => fetchRedditImpl(source.feed_url),
          { attempts: 3, baseDelayMs: 300 },
        );
        await markSourceFetchSuccess(repository, source.id);
        return entries.flatMap((entry) => {
          const primarySource = matchPrimarySource(
            entry.canonicalUrl,
            primarySources,
          );
          return [
            {
              ...entry,
              source: primarySource ?? source,
              unverified: !primarySource,
            },
          ];
        });
      }),
    );
    const gdeltSettled = await mapSettledWithConcurrency(
      gdeltSources,
      1,
      async (source) => {
        const entries = await retryImpl(
          () =>
            fetchGdeltImpl(source.feed_url, {
              topicCodes: normalizedSettings?.topicCodes ?? ["ai"],
              customTopics: normalizedSettings?.customTopics ?? [],
              windowHours,
            }),
          { attempts: 2, baseDelayMs: 5_500 },
        );
        await markSourceFetchSuccess(repository, source.id);
        return entries.map((entry) => {
          const approvedSource = matchPrimarySource(
            entry.canonicalUrl,
            primarySources,
          );
          const discoveredSource =
            approvedSource ?? webSourceForUrl(entry.canonicalUrl);
          return {
            ...entry,
            source: discoveredSource,
            publisher: entry.publisher ?? discoveredSource.name,
            verificationStatus: approvedSource
              ? "primary_source"
              : "web_source",
          };
        });
      },
    );
    let candidates = [
      ...directCandidates,
      ...redditSettled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
      ...gdeltSettled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
    ];
    const feedErrors = settled
      .map((result, index) =>
        result.status === "rejected"
          ? {
              source_id: rssSources[index].id,
              error: result.reason?.message ?? String(result.reason),
            }
          : null,
      )
      .filter(Boolean);
    feedErrors.push(
      ...redditSettled
        .map((result, index) =>
          result.status === "rejected"
            ? {
                source_id: redditSources[index].id,
                error: result.reason?.message ?? String(result.reason),
              }
            : null,
        )
        .filter(Boolean),
    );
    feedErrors.push(
      ...gdeltSettled
        .map((result, index) =>
          result.status === "rejected"
            ? {
                source_id: gdeltSources[index].id,
                error: result.reason?.message ?? String(result.reason),
              }
            : null,
        )
        .filter(Boolean),
    );
    await Promise.all(
      settled.map((result, index) =>
        result.status === "rejected"
          ? markSourceFetchFailure(
              repository,
              rssSources[index].id,
              result.reason,
            )
          : null,
      ),
    );
    await Promise.all(
      redditSettled.map((result, index) =>
        result.status === "rejected"
          ? markSourceFetchFailure(
              repository,
              redditSources[index].id,
              result.reason,
            )
          : null,
      ),
    );
    await Promise.all(
      gdeltSettled.map((result, index) =>
        result.status === "rejected"
          ? markSourceFetchFailure(
              repository,
              gdeltSources[index].id,
              result.reason,
            )
          : null,
      ),
    );
    const initialPolicy = await applyPolicy(candidates, "discovery");
    candidates = initialPolicy.eligible;
    let ranked = rankCandidates(candidates, {
      now,
      keywords,
      windowHours,
    });
    let sourceDiscovery = null;
    let providerDiscovery = null;

    if (ranked.length === 0 && discoveryProvider?.searchFeeds) {
      sourceDiscovery = await discoverNewFeedSources({
        repository,
        aiProvider: discoveryProvider,
        newsSettings: normalizedSettings ?? {
          languageCode: "en",
          topicCodes: ["ai"],
          customTopics: [],
        },
        fetchFeedImpl,
        retryImpl,
        searchRunId: run.id,
      });
      const discoveredCandidates = sourceDiscovery.sources.flatMap(
        ({ source, entries }) =>
          newestFeedEntries(entries).map((entry) => ({
            ...entry,
            source,
            publisher: source.name,
            discoveryKind: "discovered_rss_feed",
          })),
      );
      const discoveredPolicy = await applyPolicy(
        discoveredCandidates,
        "discovered_feed",
      );
      candidates = [...candidates, ...discoveredPolicy.eligible];
      ranked = rankCandidates(candidates, { now, keywords, windowHours });
    }

    if (ranked.length === 0 && discoveryProvider?.searchNews) {
      try {
        const providerRequest = {
          query,
          windowHours,
          limit: 8,
        };
        if (normalizedSettings) {
          providerRequest.languageCode = normalizedSettings.languageCode;
          providerRequest.topicCodes = [...normalizedSettings.topicCodes];
          providerRequest.customTopics = [...normalizedSettings.customTopics];
          if (excludedTopicCodes.length) {
            providerRequest.excludedTopics = excludedTopicDefinitions(
              excludedTopicCodes,
            );
          }
        }
        providerDiscovery = await discoveryProvider.searchNews(providerRequest);
        await recordAiUsageEvents(repository, providerDiscovery.usageEvents, {
          channelId: normalizedSettings?.channelId ?? null,
          searchRunId: run.id,
        });
        const seenWebPublishers = new Set();
        const providerCandidates = providerDiscovery.items.flatMap(
          (item, searchRank) => {
            let canonicalUrl;
            let source;
            try {
              canonicalUrl = canonicalizeUrl(
                assertPublicHttpUrl(item.url).toString(),
              );
              source =
                matchPrimarySource(canonicalUrl, primarySources) ??
                webSourceForUrl(canonicalUrl);
              const publisherHost = new URL(canonicalUrl).hostname.replace(
                /^www\./,
                "",
              );
              if (!source.is_primary && seenWebPublishers.has(publisherHost)) {
                return [];
              }
              if (!source.is_primary) {
                seenWebPublishers.add(publisherHost);
              }
            } catch {
              return [];
            }
            const publishedAt = item.publishedAt
              ? new Date(item.publishedAt)
              : null;
            return [
              {
                title: item.title,
                canonicalUrl,
                author: item.author ?? null,
                publishedAt:
                  publishedAt && !Number.isNaN(publishedAt.valueOf())
                    ? publishedAt.toISOString()
                    : null,
                summary: item.summary,
                contentHash: hashText(
                  [canonicalUrl, item.title, item.summary].join("\n"),
                ),
                source,
                publisher: source.is_primary
                  ? source.name
                  : new URL(canonicalUrl).hostname.replace(/^www\./, ""),
                verificationStatus: source.is_primary
                  ? "primary_source"
                  : "web_source",
                searchRank,
                discoveryKind: `${providerDiscovery.provider}_web_search`,
                languageCode: normalizedSettings?.languageCode ?? null,
              },
            ];
          },
        );
        const providerPolicy = await applyPolicy(
          providerCandidates,
          "provider_search",
        );
        candidates = [...candidates, ...providerPolicy.eligible];
        ranked = rankCandidates(candidates, {
          now,
          keywords,
          windowHours,
        });
      } catch (error) {
        providerDiscovery = {
          error: error?.code ?? "provider_search_failed",
        };
      }
    }

    let candidateCuration = null;
    if (ranked.length && discoveryProvider?.generateStructured) {
      try {
        candidateCuration = await curateNewsCandidates({
          aiProvider: discoveryProvider,
          candidates: ranked,
          newsSettings: normalizedSettings ?? {
            languageCode: "en",
            topicCodes: ["ai"],
            customTopics: [],
          },
        });
        await recordAiUsageEvents(
          repository,
          candidateCuration.usageEvents,
          {
            channelId: normalizedSettings?.channelId ?? null,
            searchRunId: run.id,
          },
        );
        ranked = candidateCuration.candidates;
      } catch (error) {
        await recordAiUsageEvents(repository, error?.usageEvents, {
          channelId: normalizedSettings?.channelId ?? null,
          searchRunId: run.id,
        });
        candidateCuration = {
          error: error?.code ?? "candidate_curation_failed",
        };
      }
    }

    if (!ranked.length) {
      const policySummary = excludedTopicPolicySummary();
      const allAcquiredCandidatesBlocked =
        policySummary.input_count > 0 &&
        policySummary.eligible_count === 0 &&
        policySummary.blocked_count === policySummary.input_count;
      if (allAcquiredCandidatesBlocked) {
        await finishPolicyFilteredSearchRun("acquisition");
      }
      throw new NoResearchCandidatesError(
        policySummary.blocked_count > 0
          ? "No recent news candidates remained after excluded-topic policy"
          : "No recent news candidates were found",
      );
    }

    const articles = [];
    for (const candidate of ranked.slice(0, MAX_PERSISTED_CANDIDATES)) {
      const verificationStatus =
        candidate.verificationStatus ??
        (candidate.unverified
          ? "unverified_community"
          : candidate.source.is_primary
            ? "primary_source"
            : "web_source");
      const article = await repository.createOrResumeArticleCandidate({
        source_id: candidate.source.id,
        search_run_id: run.id,
        canonical_url: candidate.canonicalUrl,
        title: candidate.title,
        author: candidate.author,
        published_at: candidate.publishedAt,
        content_hash: candidate.contentHash,
        status: "discovered",
        metadata: {
          feed_summary: candidate.summary,
          research_score: candidate.score,
          primary_source: candidate.source.is_primary,
          verification_status: verificationStatus,
          publisher: candidate.publisher ?? candidate.source.name,
          search_rank: candidate.searchRank ?? null,
          discovery_kind: candidate.discoveryKind ?? "primary_feed",
          discovery_url: candidate.discoveryUrl ?? null,
        },
      });
      if (!article) {
        continue;
      }
      await repository.saveRawContent({
        article_id: article.id,
        content: candidate.summary || candidate.title,
        content_type: "text",
        language_code: candidate.languageCode ?? null,
        extractor: "discovery-summary",
        content_hash: candidate.contentHash,
        metadata: {
          source_url: candidate.canonicalUrl,
          extraction_kind: "discovery_summary",
          discovery_url: candidate.discoveryUrl ?? null,
        },
      });
      articles.push({ ...candidate, verificationStatus, article });
    }

    if (!articles.length) {
      throw new NoResearchCandidatesError(
        "No new news articles were found",
      );
    }

    const extractionErrors = [];
    const storyDeduplication = {
      enabled:
        typeof repository.listRecentPublishedStories === "function" &&
        typeof repository.recordStoryDedupDecision === "function",
      compared: 0,
      duplicates: 0,
      followUps: 0,
      uncertain: 0,
      aiCalls: 0,
    };
    const deduplicationRejectedArticleIds = new Set();
    const exclusionRejectedArticleIds = new Set();
    const recentPublishedStories = storyDeduplication.enabled
      ? await repository.listRecentPublishedStories({
          channelId: normalizedSettings?.channelId ?? null,
          since: new Date(
            now.valueOf() - STORY_HISTORY_DAYS * 24 * HOUR_MS,
          ).toISOString(),
          limit: MAX_STORY_HISTORY,
        })
      : [];
    let selected = null;
    const evidenceAllowed = async (candidate, evidenceText) => {
      const result = await applyPolicy(
        [{ ...candidate, evidenceText }],
        "selected_evidence",
        { articleId: candidate.article.id },
      );
      if (result.eligible.length) return true;
      const rejection = result.blocked[0];
      await repository.transitionArticle(
        candidate.article.id,
        "discovered",
        "rejected",
        {
          metadata: {
            ...(candidate.article.metadata ?? {}),
            excluded_topic_policy: {
              stage: "selected_evidence",
              policy_codes: [...excludedTopicCodes],
              prompt_version: EXCLUDED_TOPIC_POLICY_PROMPT_VERSION,
              reason: rejection?.reason ?? "semantic_uncertain",
              policy_code: rejection?.policyCode ?? null,
            },
          },
        },
      );
      exclusionRejectedArticleIds.add(candidate.article.id);
      return false;
    };
    for (const candidate of articles) {
      if (storyDeduplication.enabled) {
        const storyDecision = await evaluateStoryDuplicate({
          candidate,
          publishedStories: recentPublishedStories,
          aiProvider:
            storyDeduplication.aiCalls < MAX_SEMANTIC_STORY_AI_CALLS
              ? discoveryProvider?.generateStructuredOnce
                ? {
                    generateStructured: (input) =>
                      discoveryProvider.generateStructuredOnce(input),
                  }
                : discoveryProvider
              : null,
        });
        if (storyDecision.classifierAttempted) {
          storyDeduplication.aiCalls += 1;
        }
        await recordAiUsageEvents(repository, storyDecision.usageEvents, {
          channelId: normalizedSettings?.channelId ?? null,
          searchRunId: run.id,
          articleId: candidate.article.id,
        });
        await repository.recordStoryDedupDecision({
          articleId: candidate.article.id,
          storyFingerprint: storyDecision.fingerprint,
          relation: storyDecision.relation,
          duplicateOfArticleId: storyDecision.duplicateOfArticleId,
          confidence: storyDecision.confidence,
          reason: storyDecision.reason,
          decisionSource: storyDecision.decisionSource,
          metadata: {
            comparison_window_days: STORY_HISTORY_DAYS,
            semantic_ai_call_limit: MAX_SEMANTIC_STORY_AI_CALLS,
            shortlist: storyDecision.shortlist,
          },
        });
        storyDeduplication.compared += 1;
        if (storyDecision.relation === "duplicate") {
          storyDeduplication.duplicates += 1;
          deduplicationRejectedArticleIds.add(candidate.article.id);
          await repository.transitionArticle(
            candidate.article.id,
            "discovered",
            "rejected",
          );
          continue;
        }
        if (storyDecision.relation === "uncertain") {
          storyDeduplication.uncertain += 1;
          deduplicationRejectedArticleIds.add(candidate.article.id);
          continue;
        }
        if (storyDecision.relation === "follow_up") {
          storyDeduplication.followUps += 1;
        }
      }
      if (candidate.verificationStatus === "unverified_community") {
        const evidenceText = candidate.summary || candidate.title;
        if (!(await evidenceAllowed(candidate, evidenceText))) {
          continue;
        }
        selected = {
          ...candidate,
          evidenceText,
        };
        break;
      }
      let extracted;
      try {
        extracted = await retryImpl(
          () => fetchArticleImpl(candidate.canonicalUrl),
          { attempts: 3, baseDelayMs: 300 },
        );
      } catch (error) {
        extractionErrors.push({
          article_id: candidate.article.id,
          source_url: candidate.canonicalUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      await repository.saveRawContent({
        article_id: candidate.article.id,
        content: extracted.text,
        content_type: "text",
        language_code: null,
        extractor: candidate.source.is_primary
          ? "primary-html"
          : "web-html",
        content_hash: extracted.contentHash,
        metadata: {
          source_url: candidate.canonicalUrl,
          final_url: extracted.finalUrl,
          extraction_kind: candidate.source.is_primary
            ? "primary_article_text"
            : "web_article_text",
        },
      });
      if (!(await evidenceAllowed(candidate, extracted.text))) {
        continue;
      }
      selected = {
        ...candidate,
        evidenceText: extracted.text,
        evidenceUrl: extracted.finalUrl ?? candidate.canonicalUrl,
      };
      break;
    }

    if (!selected) {
      for (const webSearchFallback of articles) {
        const evidenceText = String(
          webSearchFallback.summary || webSearchFallback.title,
        ).trim();
        if (
          deduplicationRejectedArticleIds.has(
            webSearchFallback.article.id,
          ) ||
          exclusionRejectedArticleIds.has(webSearchFallback.article.id) ||
          webSearchFallback.verificationStatus !== "web_source" ||
          !evidenceText
        ) {
          continue;
        }
        if (!(await evidenceAllowed(webSearchFallback, evidenceText))) {
          continue;
        }
        selected = {
          ...webSearchFallback,
          verificationStatus: "web_search_summary",
          evidenceText,
          evidenceKind: "web_search_summary",
        };
        break;
      }
    }

    if (!selected) {
      for (const feedFallback of articles) {
        const evidenceText = String(
          feedFallback.summary || feedFallback.title,
        ).trim();
        if (
          deduplicationRejectedArticleIds.has(feedFallback.article.id) ||
          exclusionRejectedArticleIds.has(feedFallback.article.id) ||
          !feedFallback.source.is_primary ||
          !evidenceText
        ) {
          continue;
        }
        if (!(await evidenceAllowed(feedFallback, evidenceText))) {
          continue;
        }
        selected = {
          ...feedFallback,
          evidenceText,
          evidenceKind: "primary_feed_summary",
        };
        break;
      }
    }

    if (!selected) {
      const remainingAfterDeduplication = articles.filter(
        (candidate) =>
          !deduplicationRejectedArticleIds.has(candidate.article.id),
      );
      if (
        remainingAfterDeduplication.length > 0 &&
        remainingAfterDeduplication.every((candidate) =>
          exclusionRejectedArticleIds.has(candidate.article.id),
        )
      ) {
        await finishPolicyFilteredSearchRun("selected_evidence");
        throw new NoResearchCandidatesError(
          "No ranked news evidence remained after excluded-topic policy",
        );
      }
      throw new Error("No ranked news evidence could be extracted");
    }

    await repository.finishSearchRun(run.id, {
      resultCount: articles.length,
      metadata: {
        keywords,
        window_hours: windowHours,
        feed_errors: feedErrors,
        extraction_errors: extractionErrors,
        selected_article_id: selected.article.id,
        selected_evidence_kind:
          selected.evidenceKind ??
          (selected.verificationStatus === "web_source"
            ? "web_article_text"
            : "primary_article_text"),
        provider_discovery: providerDiscovery
          ? {
              provider: providerDiscovery.provider ?? null,
              model: providerDiscovery.model ?? null,
              count: providerDiscovery.items?.length ?? 0,
              error: providerDiscovery.error ?? null,
            }
          : null,
        source_discovery: sourceDiscovery
          ? {
              status: sourceDiscovery.status,
              provider: sourceDiscovery.provider ?? null,
              model: sourceDiscovery.model ?? null,
              count: sourceDiscovery.sources.length,
              rejected_count: sourceDiscovery.failures?.length ?? 0,
              error: sourceDiscovery.error ?? null,
            }
          : null,
        free_discovery: {
          feed_candidate_count:
            directCandidates.length +
            (sourceDiscovery?.sources ?? []).reduce(
              (count, item) => count + item.entries.length,
              0,
            ),
          reddit_candidate_count: redditSettled.flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
          ).length,
          gdelt_candidate_count: gdeltSettled.flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
          ).length,
        },
        candidate_curation: candidateCuration
          ? {
              provider: candidateCuration.provider ?? null,
              model: candidateCuration.model ?? null,
              considered_count: candidateCuration.consideredCount ?? 0,
              ranked_count: candidateCuration.rankedCount ?? 0,
              error: candidateCuration.error ?? null,
            }
          : null,
        story_deduplication: {
          enabled: storyDeduplication.enabled,
          comparison_window_days: STORY_HISTORY_DAYS,
          history_count: recentPublishedStories.length,
          compared_count: storyDeduplication.compared,
          duplicate_count: storyDeduplication.duplicates,
          follow_up_count: storyDeduplication.followUps,
          uncertain_count: storyDeduplication.uncertain,
          semantic_ai_call_count: storyDeduplication.aiCalls,
          semantic_ai_call_limit: MAX_SEMANTIC_STORY_AI_CALLS,
        },
        ...(excludedTopicCodes.length
          ? { excluded_topic_policy: excludedTopicPolicySummary() }
          : {}),
        news_settings: settingsSnapshot,
      },
    });

    return {
      runId: run.id,
      selected,
      candidates: articles,
      feedErrors,
      extractionErrors,
    };
  } catch (error) {
    if (!terminalRunRecorded) {
      await repository.failSearchRun(run.id, error);
    }
    throw error;
  }
}
