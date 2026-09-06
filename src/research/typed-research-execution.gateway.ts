import { Inject, Injectable, Optional } from "@nestjs/common";

import { applyExcludedTopicPolicy, excludedTopicDefinitions, EXCLUDED_TOPIC_POLICY_PROMPT_VERSION } from "../excluded-topic-policy.js";
import { newsSettingsSnapshot, normalizeNewsSettings } from "../news-settings.js";
import { recordAiUsageEvents } from "../ai-usage.js";
import { hashText, canonicalizeUrl, assertPublicHttpUrl } from "../feed.js";

import type { AiProviderResult } from "../ai/ai-provider.contracts.js";
import type { FallbackAiProvider } from "../ai/ai-provider-composition.js";
import { AI_PROVIDER } from "../ai/ai-provider.tokens.js";
import type { CatalogPersistence, SourceWithTopics } from "../catalog/catalog-persistence.js";
import { CATALOG_PERSISTENCE } from "../catalog/catalog-persistence.tokens.js";
import type { StoryDeduplicationPersistence } from "../story-deduplication/story-deduplication.contracts.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "../story-deduplication/story-deduplication.tokens.js";
import type { UsageReportingPersistence } from "../usage/usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../usage/usage-persistence.tokens.js";
import type { ResearchIngestionPersistence } from "./research-persistence.contracts.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "./research-persistence.tokens.js";
import {
  EvidenceCurationService,
  SEMANTIC_ATTEMPT_CEILING,
} from "./curation/evidence-curation.engine.js";
import { SOURCE_ACQUISITION } from "./source-acquisition.tokens.js";
import type { ArticleContentPort } from "./content/article-content.contracts.js";
import { ARTICLE_CONTENT_PORT } from "./content/article-content.tokens.js";
import type { SourceAcquisition } from "./source-acquisition.contracts.js";
import type {
  ResearchExecutionCandidate,
  ResearchExecutionGateway,
  ResearchExecutionRequest,
  ResearchExecutionSource,
  RunResearchResult,
} from "./research-gateway.contracts.js";

const HOUR_MS = 60 * 60 * 1000;
const FEED_CONCURRENCY = 8;
const MAX_ENTRIES_PER_FEED = 40;
const MAX_PERSISTED_CANDIDATES = 80;
const STORY_HISTORY_DAYS = 14;
const MAX_STORY_HISTORY = 100;
// The paid-call ceiling, imported rather than restated. It was a separate
// literal here, which is why raising either copy alone silently did nothing.
const MAX_SEMANTIC_STORY_AI_CALLS = SEMANTIC_ATTEMPT_CEILING;

export class NoResearchCandidatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoResearchCandidatesError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers ported verbatim from src/research.js. Kept as free functions
// (not private methods) so they stay independently testable and so this file
// has no runtime dependency on the legacy module it replaces.
// ---------------------------------------------------------------------------

function keywordScore(candidate: { title: string; summary: string }, keywords: string[]): number {
  if (!keywords.length) return 0;
  const haystack = `${candidate.title} ${candidate.summary}`.toLowerCase();
  const matches = keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
  return Math.min(20, matches * 5);
}

function sourceHostname(source: ResearchExecutionSource): string | null {
  for (const value of [source.homepage_url, source.feed_url]) {
    try {
      if (value) return new URL(value).hostname.toLowerCase();
    } catch {
      // Invalid source URLs are rejected by the source registry.
    }
  }
  return null;
}

function webSourceForUrl(value: string): ResearchExecutionSource {
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

type NormalizedNewsSettings = ReturnType<typeof normalizeNewsSettings>;

function sourceMatchesSettings(source: SourceWithTopics, settings: NormalizedNewsSettings | null): boolean {
  if (!settings) return true;
  const sourceTopicCodes = source.topic_codes;
  if (Array.isArray(sourceTopicCodes) && sourceTopicCodes.some((code) => settings.topicCodes.includes(code))) {
    return true;
  }
  const discoveredTopics = (source.discovery_metadata as { custom_topics?: unknown } | null)?.custom_topics;
  if (Array.isArray(discoveredTopics) && settings.customTopics.length) {
    const selected = new Set(settings.customTopics.map((topic) => topic.trim().toLowerCase()));
    if (discoveredTopics.some((topic) => selected.has(String(topic).trim().toLowerCase()))) {
      return true;
    }
  }
  if (Array.isArray(sourceTopicCodes) && sourceTopicCodes.length) return false;
  // Existing static RSS/API sources are AI-specific. Untagged sources are
  // therefore eligible only when AI is one of the selected subjects.
  return settings.topicCodes.includes("ai");
}

function sourceUsesHost(source: SourceWithTopics, expectedHost: string): boolean {
  try {
    return new URL(source.feed_url ?? "").hostname.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

function newestFeedEntries<T extends { publishedAt: string | null }>(entries: T[], limit = MAX_ENTRIES_PER_FEED): T[] {
  return [...entries]
    .sort((left, right) => (Date.parse(right.publishedAt ?? "") || 0) - (Date.parse(left.publishedAt ?? "") || 0))
    .slice(0, limit);
}

type SettledResult<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

async function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<SettledResult<R>[]> {
  const results: SettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await operation(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}

export function matchPrimarySource(url: string, sources: ResearchExecutionSource[]): ResearchExecutionSource | undefined {
  const hostname = new URL(url).hostname.toLowerCase();
  return sources.find((source) => {
    const sourceHost = sourceHostname(source);
    return sourceHost && (hostname === sourceHost || hostname.endsWith(`.${sourceHost}`));
  });
}

export function scoreCandidate(
  candidate: { title: string; summary: string; publishedAt: string | null; discoveryKind?: string; searchRank?: number | null },
  source: ResearchExecutionSource,
  { now = new Date(), keywords = [] as string[] } = {},
): number {
  const reliability = source.reliability_score ?? 50;
  const publishedAt = candidate.publishedAt ? new Date(candidate.publishedAt) : null;
  const ageHours = publishedAt && !Number.isNaN(publishedAt.valueOf())
    ? Math.max(0, (now.valueOf() - publishedAt.valueOf()) / HOUR_MS)
    : 72;
  const recency = Math.max(0, 30 - Math.min(30, ageHours * 0.625));
  const primary = source.is_primary ? 30 : 0;
  const discovery = candidate.discoveryKind === "reddit"
    ? 5
    : candidate.discoveryKind?.endsWith("_web_search")
      ? Math.max(20, 40 - (candidate.searchRank ?? 0) * 4)
      : 0;
  return Number((reliability * 0.2 + recency + primary + keywordScore(candidate, keywords) + discovery).toFixed(3));
}

type ScorableCandidate = ResearchExecutionCandidate & {
  source: ResearchExecutionSource;
  score?: number;
};

export function rankCandidates(
  candidates: ScorableCandidate[],
  { now = new Date(), keywords = [] as string[], windowHours = 48 } = {},
): ScorableCandidate[] {
  const cutoff = now.valueOf() - windowHours * HOUR_MS;
  const unique = new Map<string, ScorableCandidate>();
  for (const candidate of candidates) {
    const publishedAt = candidate.publishedAt ? new Date(candidate.publishedAt).valueOf() : Number.NaN;
    if (!Number.isNaN(publishedAt) && publishedAt < cutoff) continue;
    const existing = unique.get(candidate.canonicalUrl);
    const scored = { ...candidate, score: scoreCandidate(candidate, candidate.source, { now, keywords }) };
    if (!existing || (scored.score ?? 0) > (existing.score ?? 0)) {
      unique.set(candidate.canonicalUrl, scored);
    }
  }
  return [...unique.values()].sort(
    (left, right) =>
      (right.score ?? 0) - (left.score ?? 0)
      || (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "")
      || left.canonicalUrl.localeCompare(right.canonicalUrl),
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(value && typeof value === "object" && "aborted" in value);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Research run aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal && isAbortSignal(signal) && signal.aborted) throw abortReason(signal);
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

@Injectable()
export class TypedResearchExecutionGateway implements ResearchExecutionGateway {
  constructor(
    @Inject(SOURCE_ACQUISITION) private readonly acquisition: SourceAcquisition,
    // Explicit token rather than relying on emitted `design:paramtypes`:
    // tsc emits decorator metadata but tsx does not, so a bare class
    // parameter resolves in the compiled build and fails under the test
    // runner. An explicit token behaves identically in both.
    @Inject(EvidenceCurationService) private readonly curation: EvidenceCurationService,
    @Inject(AI_PROVIDER) private readonly ai: FallbackAiProvider,
    @Inject(CATALOG_PERSISTENCE) private readonly catalog: CatalogPersistence,
    @Inject(RESEARCH_INGESTION_PERSISTENCE) private readonly research: ResearchIngestionPersistence,
    @Inject(STORY_DEDUPLICATION_PERSISTENCE) private readonly storyDedup: StoryDeduplicationPersistence,
    @Inject(USAGE_REPORTING_PERSISTENCE) private readonly usage: UsageReportingPersistence,
    @Optional() private readonly now: () => Date = () => new Date(),
    @Optional() private readonly log: Pick<Console, "info" | "warn"> = console,
    // Last on purpose. Every existing call site passes these positionally, and
    // inserting ahead of them silently rebinds `now` to a content port -- which
    // is exactly what happened on the first attempt, caught by the type
    // checker rather than at runtime.
    //
    // Absent, the gateway behaves exactly as it did before, which is what lets
    // this ship before it is switched on anywhere.
    @Optional()
    @Inject(ARTICLE_CONTENT_PORT)
    private readonly articleContent: ArticleContentPort | null = null,
  ) {}

  async execute(request: ResearchExecutionRequest, signal?: AbortSignal): Promise<RunResearchResult> {
    throwIfAborted(signal);

    const { query, keywords = [], windowHours = 48, newsSettings } = request.input;
    const normalizedSettings = newsSettings ? normalizeNewsSettings(newsSettings) : null;
    const settingsSnapshot = normalizedSettings ? newsSettingsSnapshot(normalizedSettings) : null;
    const excludedTopicCodes = normalizedSettings?.excludedTopicCodes ?? [];
    const channelId = normalizedSettings?.channelId ? String(normalizedSettings.channelId) : null;

    const run = await this.research.startSearchRun({
      query,
      metadata: { keywords, window_hours: windowHours, news_settings: settingsSnapshot },
    });
    let terminalRunRecorded = false;
    const usageRepository = { recordAiUsage: (input: unknown) => this.usage.recordAiUsage(input as never) };
    const aiAdapter = { generateStructured: (input: Record<string, unknown>) => this.ai.generateStructured({ ...input, signal }) };

    try {
      const excludedTopicAudits: Array<Record<string, unknown>> = [];

      const recordExcludedTopicPolicy = async <T extends { audit: Record<string, unknown>; usageEvents: unknown[] }>(
        policyResult: T,
        { articleId = null as string | null } = {},
      ): Promise<T> => {
        excludedTopicAudits.push(policyResult.audit);
        await recordAiUsageEvents(usageRepository, policyResult.usageEvents, {
          channelId: channelId,
          searchRunId: run.id,
          articleId,
        } as never);
        if (policyResult.audit.enabled && (Number(policyResult.audit.blockedCount) > 0 || Number(policyResult.audit.semanticClassifiedCount) > 0)) {
          try {
            this.log.info?.(JSON.stringify({ event: "excluded_topic_policy", ...policyResult.audit }));
          } catch {
            // Observability is best-effort and must not alter policy decisions.
          }
        }
        return policyResult;
      };

      const applyPolicy = async (candidates: unknown[], stage: string, context: { articleId?: string | null } = {}) =>
        recordExcludedTopicPolicy(
          (await applyExcludedTopicPolicy({ candidates, excludedTopicCodes, aiProvider: aiAdapter, stage })) as {
            audit: Record<string, unknown>;
            usageEvents: unknown[];
            eligible: ScorableCandidate[];
            blocked: Array<{ reason?: string; policyCode?: string | null }>;
          },
          context,
        );

      const excludedTopicPolicySummary = () => {
        const enabledAudits = excludedTopicAudits.filter((audit) => audit.enabled);
        const acquisitionAudits = enabledAudits.filter((audit) => audit.stage !== "selected_evidence");
        const evidenceAudits = enabledAudits.filter((audit) => audit.stage === "selected_evidence");
        const providers = new Map<string, unknown>();
        for (const audit of enabledAudits) {
          for (const provider of (audit.providers as Array<{ provider?: string; model?: string }> | undefined) ?? []) {
            const key = `${provider.provider ?? "unknown"}\u0000${provider.model ?? "unknown"}`;
            providers.set(key, provider);
          }
        }
        const sum = (audits: Array<Record<string, unknown>>, field: string) =>
          audits.reduce((total, audit) => total + Number(audit[field] ?? 0), 0);
        return {
          enabled: excludedTopicCodes.length > 0,
          policy_codes: [...excludedTopicCodes],
          prompt_version: EXCLUDED_TOPIC_POLICY_PROMPT_VERSION,
          input_count: sum(acquisitionAudits, "inputCount"),
          eligible_count: sum(acquisitionAudits, "eligibleCount"),
          blocked_count: sum(acquisitionAudits, "blockedCount"),
          deterministic_blocked_count: sum(acquisitionAudits, "deterministicBlockedCount"),
          semantic_classified_count: sum(acquisitionAudits, "semanticClassifiedCount"),
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

      const finishPolicyFilteredSearchRun = async (terminalStage: string) => {
        throwIfAborted(signal);
        await this.research.finishSearchRun(run.id, {
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

      const sources = await this.catalog.listEnabledSources();
      const primarySources = sources.filter((source) => source.is_primary) as unknown as ResearchExecutionSource[];
      const rssSources = sources.filter((source) => source.source_type === "rss" && sourceMatchesSettings(source, normalizedSettings));
      const redditSources = sources.filter(
        (source) =>
          !source.is_primary
          && sourceMatchesSettings(source, normalizedSettings)
          && source.source_type === "api"
          && source.feed_url
          && new URL(source.feed_url).hostname.endsWith("reddit.com"),
      );
      const gdeltSources = sources.filter(
        (source) =>
          !source.is_primary
          && (sourceMatchesSettings(source, normalizedSettings) || Boolean(normalizedSettings?.customTopics.length))
          && source.source_type === "api"
          && source.feed_url
          && sourceUsesHost(source, "api.gdeltproject.org"),
      );

      if (!rssSources.length && !gdeltSources.length && !this.ai.names.length) {
        throw new Error("No enabled news discovery sources are configured");
      }

      throwIfAborted(signal);

      const settled = await mapSettledWithConcurrency(rssSources, FEED_CONCURRENCY, async (source) => {
        const entries = await this.acquisition.fetchSource({ sourceId: source.id, sourceType: "rss", feedUrl: source.feed_url! });
        return newestFeedEntries(entries as Array<{ publishedAt: string | null }>).map((entry) => ({
          ...(entry as object),
          source,
          publisher: source.name,
          discoveryKind: source.is_primary ? "primary_feed" : "rss_feed",
        })) as unknown as ScorableCandidate[];
      });
      const directCandidates = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

      const redditSettled = await Promise.allSettled(
        redditSources.map(async (source) => {
          const entries = await this.acquisition.fetchSource({ sourceId: source.id, sourceType: "reddit", feedUrl: source.feed_url! });
          return entries.flatMap((entry) => {
            const canonicalUrl = (entry as { canonicalUrl: string }).canonicalUrl;
            const primarySource = matchPrimarySource(canonicalUrl, primarySources);
            return [{ ...(entry as object), source: primarySource ?? source, unverified: !primarySource }] as unknown as ScorableCandidate[];
          });
        }),
      );

      const gdeltSettled = await mapSettledWithConcurrency(gdeltSources, 1, async (source) => {
        const entries = await this.acquisition.fetchSource({
          sourceId: source.id,
          sourceType: "gdelt",
          feedUrl: source.feed_url!,
          topicCodes: normalizedSettings ? [...normalizedSettings.topicCodes] : ["ai"],
          customTopics: normalizedSettings ? [...normalizedSettings.customTopics] : [],
          windowHours,
        });
        return entries.map((entry) => {
          const canonicalUrl = (entry as { canonicalUrl: string }).canonicalUrl;
          const approvedSource = matchPrimarySource(canonicalUrl, primarySources);
          const discoveredSource = approvedSource ?? webSourceForUrl(canonicalUrl);
          return {
            ...(entry as object),
            source: discoveredSource,
            publisher: (entry as { publisher?: string }).publisher ?? discoveredSource.name,
            verificationStatus: approvedSource ? "primary_source" : "web_source",
          } as unknown as ScorableCandidate;
        });
      });

      let candidates: ScorableCandidate[] = [
        ...directCandidates,
        ...redditSettled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        ...gdeltSettled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
      ];

      const feedErrors: Array<{ source_id: string; error: string }> = [];
      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          feedErrors.push({ source_id: rssSources[index].id, error: (result.reason as { message?: string })?.message ?? String(result.reason) });
        }
      });
      redditSettled.forEach((result, index) => {
        if (result.status === "rejected") {
          feedErrors.push({ source_id: redditSources[index].id, error: (result.reason as { message?: string })?.message ?? String(result.reason) });
        }
      });
      gdeltSettled.forEach((result, index) => {
        if (result.status === "rejected") {
          feedErrors.push({ source_id: gdeltSources[index].id, error: (result.reason as { message?: string })?.message ?? String(result.reason) });
        }
      });
      // Source health (success/failure marking + retry) is already owned by
      // SourceAcquisitionGateway.fetchSource internally — no separate
      // markSourceFetchSuccess/Failure calls are needed here.

      const initialPolicy = await applyPolicy(candidates, "discovery");
      candidates = initialPolicy.eligible;
      let ranked = rankCandidates(candidates, { now: this.now(), keywords, windowHours });

      let sourceDiscovery: Record<string, unknown> | null = null;
      let providerDiscovery: Record<string, unknown> | null = null;

      if (ranked.length === 0) {
        throwIfAborted(signal);
        const discovery = await this.acquisition.discoverFeeds({
          newsSettings: normalizedSettings
            ? { channelId, languageCode: normalizedSettings.languageCode, topicCodes: [...normalizedSettings.topicCodes], customTopics: [...normalizedSettings.customTopics] }
            : { languageCode: "en", topicCodes: ["ai"], customTopics: [] },
          searchRunId: run.id,
        });
        sourceDiscovery = discovery as unknown as Record<string, unknown>;
        const discoveredCandidates = discovery.sources.flatMap(({ source, entries }) =>
          newestFeedEntries(entries).map((entry) => ({
            ...entry,
            source,
            publisher: (source as { name?: string }).name,
            discoveryKind: "discovered_rss_feed",
          })) as unknown as ScorableCandidate[],
        );
        const discoveredPolicy = await applyPolicy(discoveredCandidates, "discovered_feed");
        candidates = [...candidates, ...discoveredPolicy.eligible];
        ranked = rankCandidates(candidates, { now: this.now(), keywords, windowHours });
      }

      if (ranked.length === 0) {
        throwIfAborted(signal);
        try {
          const providerRequest: Record<string, unknown> = { query, windowHours, limit: 8 };
          if (normalizedSettings) {
            providerRequest.languageCode = normalizedSettings.languageCode;
            providerRequest.topicCodes = [...normalizedSettings.topicCodes];
            providerRequest.customTopics = [...normalizedSettings.customTopics];
            if (excludedTopicCodes.length) {
              providerRequest.excludedTopics = excludedTopicDefinitions(excludedTopicCodes);
            }
          }
          const searchResult = (await this.ai.searchNews({ ...providerRequest, signal })) as AiProviderResult & {
            items: Array<{ url: string; title: string; summary: string; author?: string | null; publishedAt?: string | null }>;
            provider: string;
          };
          providerDiscovery = searchResult;
          // Unlike discoverFeeds (called via SourceAcquisitionGateway, which
          // records usage internally), this calls the raw AI provider
          // directly — SourceAcquisitionGateway.searchNews is deliberately
          // bypassed (see module design notes), so nothing else records this
          // call's usage. Must record it here, matching research.js's own
          // explicit recordAiUsageEvents call after discoveryProvider.searchNews.
          await recordAiUsageEvents(usageRepository, searchResult.usageEvents, {
            channelId,
            searchRunId: run.id,
          } as never);
          const seenWebPublishers = new Set<string>();
          const providerCandidates = searchResult.items.flatMap((item, searchRank) => {
            let canonicalUrl: string;
            let source: ResearchExecutionSource;
            try {
              canonicalUrl = canonicalizeUrl(assertPublicHttpUrl(item.url).toString());
              source = matchPrimarySource(canonicalUrl, primarySources) ?? webSourceForUrl(canonicalUrl);
              const publisherHost = new URL(canonicalUrl).hostname.replace(/^www\./, "");
              if (!source.is_primary && seenWebPublishers.has(publisherHost)) return [];
              if (!source.is_primary) seenWebPublishers.add(publisherHost);
            } catch {
              return [];
            }
            const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
            return [
              {
                title: item.title,
                canonicalUrl,
                author: item.author ?? null,
                publishedAt: publishedAt && !Number.isNaN(publishedAt.valueOf()) ? publishedAt.toISOString() : null,
                summary: item.summary,
                contentHash: hashText([canonicalUrl, item.title, item.summary].join("\n")),
                source,
                publisher: source.is_primary ? source.name : new URL(canonicalUrl).hostname.replace(/^www\./, ""),
                verificationStatus: source.is_primary ? "primary_source" : "web_source",
                searchRank,
                discoveryKind: `${searchResult.provider}_web_search`,
                languageCode: normalizedSettings?.languageCode ?? null,
              } as unknown as ScorableCandidate,
            ];
          });
          const providerPolicy = await applyPolicy(providerCandidates, "provider_search");
          candidates = [...candidates, ...providerPolicy.eligible];
          ranked = rankCandidates(candidates, { now: this.now(), keywords, windowHours });
        } catch (error) {
          providerDiscovery = { error: (error as { code?: string })?.code ?? "provider_search_failed" };
        }
      }

      let candidateCuration: Record<string, unknown> | null = null;
      if (ranked.length) {
        throwIfAborted(signal);
        try {
          const result = await this.curation.curateNewsCandidates(
            ranked as never,
            normalizedSettings ? { ...normalizedSettings, topicCodes: [...normalizedSettings.topicCodes], customTopics: [...normalizedSettings.customTopics] } : { languageCode: "en", topicCodes: ["ai"], customTopics: [] },
            60,
          );
          candidateCuration = result;
          await recordAiUsageEvents(usageRepository, result.usageEvents, {
            channelId: channelId,
            searchRunId: run.id,
          } as never);
          ranked = result.candidates as unknown as ScorableCandidate[];
        } catch (error) {
          await recordAiUsageEvents(usageRepository, (error as { usageEvents?: unknown[] })?.usageEvents, {
            channelId: channelId,
            searchRunId: run.id,
          } as never);
          candidateCuration = { error: (error as { code?: string })?.code ?? "candidate_curation_failed" };
        }
      }

      if (!ranked.length) {
        const policySummary = excludedTopicPolicySummary();
        const allAcquiredCandidatesBlocked =
          policySummary.input_count > 0
          && policySummary.eligible_count === 0
          && policySummary.blocked_count === policySummary.input_count;
        if (allAcquiredCandidatesBlocked) {
          await finishPolicyFilteredSearchRun("acquisition");
        }
        throw new NoResearchCandidatesError(
          policySummary.blocked_count > 0
            ? "No recent news candidates remained after excluded-topic policy"
            : "No recent news candidates were found",
        );
      }

      throwIfAborted(signal);

      const articles: Array<ScorableCandidate & { article: ResearchExecutionCandidate["article"]; verificationStatus: string }> = [];
      for (const candidate of ranked.slice(0, MAX_PERSISTED_CANDIDATES)) {
        const verificationStatus =
          candidate.verificationStatus
          ?? (candidate.unverified ? "unverified_community" : candidate.source.is_primary ? "primary_source" : "web_source");
        const article = await this.research.createOrResumeArticleCandidate({
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
            research_score: candidate.score ?? null,
            primary_source: candidate.source.is_primary,
            verification_status: verificationStatus,
            publisher: candidate.publisher ?? candidate.source.name,
            search_rank: candidate.searchRank ?? null,
            discovery_kind: candidate.discoveryKind ?? "primary_feed",
            discovery_url: candidate.discoveryUrl ?? null,
          },
        });
        if (!article) continue;
        await this.research.saveRawContent({
          article_id: article.id,
          content: candidate.summary || candidate.title,
          content_type: "text",
          language_code: (candidate as { languageCode?: string | null }).languageCode ?? null,
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
        throw new NoResearchCandidatesError("No new news articles were found");
      }

      const extractionErrors: Array<{ article_id: string; source_url: string; error: string }> = [];
      const storyDeduplication = { enabled: true, compared: 0, duplicates: 0, followUps: 0, uncertain: 0, aiCalls: 0 };
      const deduplicationRejectedArticleIds = new Set<string>();
      const exclusionRejectedArticleIds = new Set<string>();
      const since = new Date(this.now().valueOf() - STORY_HISTORY_DAYS * 24 * HOUR_MS).toISOString();
      const recentPublishedStories = await this.storyDedup.listRecentPublishedStories({
        channelId,
        since,
        limit: MAX_STORY_HISTORY,
      });

      let selected: (ScorableCandidate & { article: ResearchExecutionCandidate["article"]; evidenceText: string; evidenceUrl?: string; evidenceKind?: string }) | null = null;

      const evidenceAllowed = async (candidate: (typeof articles)[number], evidenceText: string): Promise<boolean> => {
        const result = await applyPolicy([{ ...candidate, evidenceText }], "selected_evidence", { articleId: candidate.article.id });
        if (result.eligible.length) return true;
        const rejection = result.blocked[0];
        await this.research.transitionArticle(candidate.article.id, "discovered", "rejected", {
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
        });
        exclusionRejectedArticleIds.add(candidate.article.id);
        return false;
      };

      // Deliberately NOT evaluateStoryDuplicateFromPersistence: that method
      // re-fetches recentPublishedStories on every call (once per candidate),
      // where research.js fetches it exactly once per run and reuses it in
      // memory. It also persists decisions under different metadata field
      // names than research.js's finish-metadata expects. Calling the
      // lower-level evaluateStoryDuplicate + our own recordStoryDedupDecision
      // reproduces the legacy shape and query count exactly.
      const semanticBudget = this.curation.createSemanticAttemptBudget(MAX_SEMANTIC_STORY_AI_CALLS);
      const semanticProvider = {
        generateStructured: async (input: Record<string, unknown>) => {
          if (!semanticBudget.tryConsume()) throw new Error("Semantic attempt budget exhausted");
          return this.ai.generateStructuredOnce({ ...input, signal }) as never;
        },
      };

      for (const candidate of articles) {
        throwIfAborted(signal);
        const storyDecision = await this.curation.evaluateStoryDuplicate(
          candidate as never,
          recentPublishedStories,
          semanticBudget.hasRemaining() ? semanticProvider : null,
        );
        if (storyDecision.classifierAttempted) storyDeduplication.aiCalls += 1;
        await recordAiUsageEvents(usageRepository, storyDecision.usageEvents, {
          channelId,
          searchRunId: run.id,
          articleId: candidate.article.id,
        } as never);
        await this.storyDedup.recordStoryDedupDecision({
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
          await this.research.transitionArticle(candidate.article.id, "discovered", "rejected");
          continue;
        }
        if (storyDecision.relation === "uncertain") {
          storyDeduplication.uncertain += 1;
          deduplicationRejectedArticleIds.add(candidate.article.id);
          continue;
        }
        if (storyDecision.relation === "follow_up") storyDeduplication.followUps += 1;

        if (candidate.verificationStatus === "unverified_community") {
          // Two different things share this status, and treating them alike is
          // what made articles thin.
          //
          // reddit.js marks every Reddit discovery unverified, and its page
          // genuinely is a discussion thread -- reading it as an article would
          // be wrong, so those keep the summary.
          //
          // research.js marks anything from a non-primary SOURCE unverified,
          // and its page is an ordinary news article with the full text on it.
          // Reducing that to an RSS description, as if it were a forum post, is
          // how a story arrives at 317 characters pointing at a link.
          //
          // Fetching the page does not make the story verified. The status is
          // unchanged and the caveat still applies: this is more of the same
          // source, not confirmation from another one. It is corroboration
          // that lifts the caveat, and it works far better against full text
          // than against a snippet it cannot form a question from.
          const isCommunityPost = candidate.discoveryKind === "reddit";
          let evidenceText = candidate.summary || candidate.title;
          if (!isCommunityPost && this.articleContent) {
            try {
              const content = await this.articleContent.fetch(
                candidate.canonicalUrl,
              );
              if (content?.text) evidenceText = content.text;
            } catch {
              // Retrieval is an improvement, never a gate. A page that cannot
              // be read leaves the candidate exactly as it would have been --
              // thin, but present.
            }
          }
          if (!(await evidenceAllowed(candidate, evidenceText))) continue;
          selected = { ...candidate, evidenceText };
          break;
        }

        // Extract, and ask Exa before giving the candidate up.
        //
        // Three failed attempts from the HTML extractor means a paywall, a
        // JavaScript shell or bot protection -- exactly the pages a
        // purpose-built retrieval service reaches and a plain extractor does
        // not. Until now such a candidate was simply dropped, so those stories
        // were lost rather than told.
        let extracted:
          | { text: string; contentHash: string; finalUrl: string }
          | null = null;
        let extractionFailure = "article content unavailable";
        try {
          extracted = await this.curation.withRetry(
            () => this.curation.fetchArticle(candidate.canonicalUrl),
            { attempts: 3, baseDelayMs: 300 },
          );
        } catch (error) {
          extractionFailure =
            error instanceof Error ? error.message : String(error);
          if (this.articleContent) {
            try {
              const content = await this.articleContent.fetch(
                candidate.canonicalUrl,
              );
              if (content?.text) {
                extracted = {
                  text: content.text,
                  contentHash: hashText(content.text),
                  finalUrl: content.url,
                };
              }
            } catch (contentError) {
              // Both paths failed. The original extractor's message is the
              // more useful of the two, so it is the one kept.
              void contentError;
            }
          }
        }
        if (!extracted) {
          extractionErrors.push({
            article_id: candidate.article.id,
            source_url: candidate.canonicalUrl,
            error: extractionFailure,
          });
          continue;
        }
        await this.research.saveRawContent({
          article_id: candidate.article.id,
          content: extracted.text,
          content_type: "text",
          language_code: null,
          extractor: candidate.source.is_primary ? "primary-html" : "web-html",
          content_hash: extracted.contentHash,
          metadata: {
            source_url: candidate.canonicalUrl,
            final_url: extracted.finalUrl,
            extraction_kind: candidate.source.is_primary ? "primary_article_text" : "web_article_text",
          },
        });
        if (!(await evidenceAllowed(candidate, extracted.text))) continue;
        selected = { ...candidate, evidenceText: extracted.text, evidenceUrl: extracted.finalUrl ?? candidate.canonicalUrl };
        break;
      }

      if (!selected) {
        for (const webSearchFallback of articles) {
          const evidenceText = String(webSearchFallback.summary || webSearchFallback.title).trim();
          if (
            deduplicationRejectedArticleIds.has(webSearchFallback.article.id)
            || exclusionRejectedArticleIds.has(webSearchFallback.article.id)
            || webSearchFallback.verificationStatus !== "web_source"
            || !evidenceText
          ) continue;
          if (!(await evidenceAllowed(webSearchFallback, evidenceText))) continue;
          selected = { ...webSearchFallback, verificationStatus: "web_search_summary", evidenceText, evidenceKind: "web_search_summary" };
          break;
        }
      }

      if (!selected) {
        for (const feedFallback of articles) {
          const evidenceText = String(feedFallback.summary || feedFallback.title).trim();
          if (
            deduplicationRejectedArticleIds.has(feedFallback.article.id)
            || exclusionRejectedArticleIds.has(feedFallback.article.id)
            || !feedFallback.source.is_primary
            || !evidenceText
          ) continue;
          if (!(await evidenceAllowed(feedFallback, evidenceText))) continue;
          selected = { ...feedFallback, evidenceText, evidenceKind: "primary_feed_summary" };
          break;
        }
      }

      if (!selected) {
        const remainingAfterDeduplication = articles.filter((candidate) => !deduplicationRejectedArticleIds.has(candidate.article.id));
        if (
          remainingAfterDeduplication.length > 0
          && remainingAfterDeduplication.every((candidate) => exclusionRejectedArticleIds.has(candidate.article.id))
        ) {
          await finishPolicyFilteredSearchRun("selected_evidence");
          throw new NoResearchCandidatesError("No ranked news evidence remained after excluded-topic policy");
        }
        throw new Error("No ranked news evidence could be extracted");
      }

      throwIfAborted(signal);

      await this.research.finishSearchRun(run.id, {
        resultCount: articles.length,
        metadata: {
          keywords,
          window_hours: windowHours,
          feed_errors: feedErrors,
          extraction_errors: extractionErrors,
          selected_article_id: selected.article.id,
          selected_evidence_kind: selected.evidenceKind ?? (selected.verificationStatus === "web_source" ? "web_article_text" : "primary_article_text"),
          provider_discovery: providerDiscovery
            ? {
                provider: providerDiscovery.provider ?? null,
                model: providerDiscovery.model ?? null,
                count: (providerDiscovery.items as unknown[] | undefined)?.length ?? 0,
                error: providerDiscovery.error ?? null,
              }
            : null,
          source_discovery: sourceDiscovery
            ? {
                status: sourceDiscovery.status,
                provider: sourceDiscovery.provider ?? null,
                model: sourceDiscovery.model ?? null,
                count: (sourceDiscovery.sources as unknown[]).length,
                rejected_count: (sourceDiscovery.failures as unknown[] | undefined)?.length ?? 0,
                error: sourceDiscovery.error ?? null,
              }
            : null,
          free_discovery: {
            feed_candidate_count:
              directCandidates.length
              + ((sourceDiscovery?.sources as Array<{ entries: unknown[] }> | undefined) ?? []).reduce((count, item) => count + item.entries.length, 0),
            reddit_candidate_count: redditSettled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])).length,
            gdelt_candidate_count: gdeltSettled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])).length,
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
          ...(excludedTopicCodes.length ? { excluded_topic_policy: excludedTopicPolicySummary() } : {}),
          news_settings: settingsSnapshot,
        },
      });

      return {
        runId: run.id,
        selected: selected as unknown as ResearchExecutionCandidate,
        candidates: articles as unknown as ResearchExecutionCandidate[],
        feedErrors,
        extractionErrors,
      };
    } catch (error) {
      if (!terminalRunRecorded) {
        await this.research.failSearchRun(run.id, error);
      }
      throw error;
    }
  }
}
