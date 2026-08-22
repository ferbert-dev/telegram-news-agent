import { fetchArticle } from "../article-extractor.js";
import type { CatalogPersistence } from "../catalog/catalog-persistence.js";
import { fetchFeed } from "../feed.js";
import { fetchGdeltDiscoveries } from "../gdelt.js";
import { fetchRedditDiscoveries } from "../reddit.js";
import { runResearch } from "../research.js";
import { withRetry } from "../retry.js";
import type { StoryDeduplicationPersistence } from "../story-deduplication/story-deduplication.contracts.js";
import type { UsageReportingPersistence } from "../usage/usage-persistence.contracts.js";
import type {
  ResearchExecutionGateway,
  ResearchExecutionRequest,
  ResearchJsonObject,
  RunResearchResult,
} from "./research-gateway.contracts.js";
import type { ResearchIngestionPersistence } from "./research-persistence.contracts.js";

export type LegacyResearchRepositoryPort = Pick<
  CatalogPersistence,
  | "listEnabledSources"
  | "markSourceChecked"
  | "markSourceFetchSuccess"
  | "markSourceFetchFailure"
  | "claimSourceDiscovery"
  | "completeSourceDiscovery"
  | "upsertDiscoveredSource"
> &
  Pick<
    ResearchIngestionPersistence,
    | "startSearchRun"
    | "finishSearchRun"
    | "failSearchRun"
    | "createOrResumeArticleCandidate"
    | "saveRawContent"
    | "transitionArticle"
  > &
  Pick<
    StoryDeduplicationPersistence,
    "listRecentPublishedStories" | "recordStoryDedupDecision"
  > &
  Pick<UsageReportingPersistence, "recordAiUsage">;

export type LegacyResearchDiscoveryProvider = Record<string, unknown>;

export type LegacyResearchLog = Pick<Console, "info" | "warn">;

export type LegacyRunResearchInput = {
  repository: LegacyResearchRepositoryPort;
  query: string;
  keywords: string[];
  windowHours: number;
  fetchFeedImpl: typeof fetchFeed;
  fetchRedditImpl: typeof fetchRedditDiscoveries;
  fetchGdeltImpl: typeof fetchGdeltDiscoveries;
  fetchArticleImpl: typeof fetchArticle;
  discoveryProvider: LegacyResearchDiscoveryProvider;
  retryImpl: typeof withRetry;
  now: Date;
  newsSettings?: ResearchJsonObject | null;
  log: LegacyResearchLog;
};

export type LegacyRunResearch = (
  input: LegacyRunResearchInput,
) => Promise<RunResearchResult>;

export type LegacyResearchExecutionDependencies = {
  discoveryProvider: LegacyResearchDiscoveryProvider;
  fetchFeedImpl?: typeof fetchFeed;
  fetchRedditImpl?: typeof fetchRedditDiscoveries;
  fetchGdeltImpl?: typeof fetchGdeltDiscoveries;
  fetchArticleImpl?: typeof fetchArticle;
  retryImpl?: typeof withRetry;
  runResearchImpl?: LegacyRunResearch;
  now?: () => Date;
  log?: LegacyResearchLog;
};

const defaultRunResearch = runResearch as unknown as LegacyRunResearch;

function legacyRepository(
  catalog: CatalogPersistence,
  research: ResearchIngestionPersistence,
  storyDeduplication: StoryDeduplicationPersistence,
  usage: UsageReportingPersistence,
): LegacyResearchRepositoryPort {
  return {
    listEnabledSources: (...args) => catalog.listEnabledSources(...args),
    markSourceChecked: (...args) => catalog.markSourceChecked(...args),
    markSourceFetchSuccess: (...args) =>
      catalog.markSourceFetchSuccess(...args),
    markSourceFetchFailure: (...args) =>
      catalog.markSourceFetchFailure(...args),
    claimSourceDiscovery: (...args) =>
      catalog.claimSourceDiscovery(...args),
    completeSourceDiscovery: (...args) =>
      catalog.completeSourceDiscovery(...args),
    upsertDiscoveredSource: (...args) =>
      catalog.upsertDiscoveredSource(...args),
    startSearchRun: (...args) => research.startSearchRun(...args),
    finishSearchRun: (...args) => research.finishSearchRun(...args),
    failSearchRun: (...args) => research.failSearchRun(...args),
    createOrResumeArticleCandidate: (...args) =>
      research.createOrResumeArticleCandidate(...args),
    saveRawContent: (...args) => research.saveRawContent(...args),
    transitionArticle: (...args) => research.transitionArticle(...args),
    listRecentPublishedStories: (...args) =>
      storyDeduplication.listRecentPublishedStories(...args),
    recordStoryDedupDecision: (...args) =>
      storyDeduplication.recordStoryDedupDecision(...args),
    recordAiUsage: (...args) => usage.recordAiUsage(...args),
  };
}

/**
 * Compatibility adapter for the existing stateful research engine. It only
 * assembles narrow ports and preserves the legacy result/error identity.
 */
export class LegacyResearchExecutionGateway implements ResearchExecutionGateway {
  private readonly repository: LegacyResearchRepositoryPort;

  constructor(
    catalog: CatalogPersistence,
    research: ResearchIngestionPersistence,
    storyDeduplication: StoryDeduplicationPersistence,
    usage: UsageReportingPersistence,
    private readonly dependencies: LegacyResearchExecutionDependencies,
  ) {
    this.repository = legacyRepository(
      catalog,
      research,
      storyDeduplication,
      usage,
    );
  }

  async execute(
    request: ResearchExecutionRequest,
    signal?: AbortSignal,
  ): Promise<RunResearchResult> {
    // The legacy engine cannot be cancelled safely after it starts mutating.
    // A pre-aborted signal therefore prevents all effects; later aborts are
    // deliberately ignored until the typed engine replaces this adapter.
    signal?.throwIfAborted();

    const input = request.input;
    const runResearchImpl =
      this.dependencies.runResearchImpl ?? defaultRunResearch;
    return runResearchImpl({
      repository: this.repository,
      query: input.query,
      keywords: input.keywords ?? [],
      windowHours: input.windowHours ?? 48,
      fetchFeedImpl: this.dependencies.fetchFeedImpl ?? fetchFeed,
      fetchRedditImpl:
        this.dependencies.fetchRedditImpl ?? fetchRedditDiscoveries,
      fetchGdeltImpl:
        this.dependencies.fetchGdeltImpl ?? fetchGdeltDiscoveries,
      fetchArticleImpl: this.dependencies.fetchArticleImpl ?? fetchArticle,
      discoveryProvider: this.dependencies.discoveryProvider,
      retryImpl: this.dependencies.retryImpl ?? withRetry,
      now: this.dependencies.now?.() ?? new Date(),
      newsSettings: input.newsSettings,
      log: this.dependencies.log ?? console,
    });
  }
}
