import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceCurationService } from "../../src/research/curation/evidence-curation.engine.js";
import { NoResearchCandidatesError, TypedResearchExecutionGateway } from "../../src/research/typed-research-execution.gateway.js";

import type { CatalogPersistence, SourceWithTopics } from "../../src/catalog/catalog-persistence.js";
import type { ResearchIngestionPersistence } from "../../src/research/research-persistence.contracts.js";
import type { SourceAcquisition } from "../../src/research/source-acquisition.contracts.js";
import type { StoryDeduplicationPersistence } from "../../src/story-deduplication/story-deduplication.contracts.js";
import type { UsageReportingPersistence } from "../../src/usage/usage-persistence.contracts.js";
import type { FallbackAiProvider } from "../../src/ai/ai-provider-composition.js";

const NOW = new Date("2026-06-27T00:00:00Z");

const PRIMARY_SOURCE: SourceWithTopics = {
  id: "source-1",
  name: "Primary Source",
  homepage_url: "https://example.com",
  feed_url: "https://example.com/feed",
  source_type: "rss",
  reliability_score: 90,
  enabled: true,
  last_checked_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  is_primary: true,
  last_success_at: null,
  last_failed_at: null,
  consecutive_failures: 0,
  last_error_code: null,
  disabled_until: null,
  discovered_by: "seed",
  discovery_metadata: {},
  topic_codes: [],
};

const FEED_ENTRY = {
  title: "New AI agent released",
  canonicalUrl: "https://example.com/agent",
  author: "Research Team",
  publishedAt: "2026-06-26T18:00:00Z",
  summary: "A new agent model for research.",
  contentHash: "hash",
};

const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];
const noSleep = { async sleep() {} };

const curationGenerator = {
  async generateStructured(input: { schemaName: string; input: unknown }) {
    assert.equal(input.schemaName, "news_candidate_curation");
    const candidates = (input.input as { candidates: Array<{ id: string }> }).candidates;
    return { value: { rankedCandidateIds: candidates.map((c) => c.id) }, provider: "openai", model: "test", usageEvents: [] };
  },
};

function fakeAi(overrides: Partial<FallbackAiProvider> = {}): FallbackAiProvider {
  return {
    names: ["openai"],
    async generateStructured() {
      throw new Error("unexpected generateStructured on the raw fake — excluded-topic policy should not need it here");
    },
    async generateStructuredOnce() {
      throw new Error("unexpected generateStructuredOnce on the raw fake");
    },
    async searchNews() {
      throw new Error("unexpected searchNews — this test should not fall back to paid search");
    },
    async searchFeeds() {
      throw new Error("unexpected searchFeeds — this test should not fall back to feed discovery");
    },
    async searchFact() {
      throw new Error("unexpected searchFact");
    },
    async testConnection() {
      throw new Error("unexpected testConnection");
    },
    async testExaConnection() {
      throw new Error("unexpected testExaConnection");
    },
    ...overrides,
  };
}

function fakeUsage(): UsageReportingPersistence {
  return {
    async recordAiUsage() {
      return {} as never;
    },
    async getDailyUsageDashboard() {
      return {} as never;
    },
  };
}

function buildGateway({
  acquisition,
  catalog,
  research,
  storyDedup,
  usage,
  ai = fakeAi(),
  articleHtml = `<article><p>${"Extracted primary article evidence with enough length to pass extraction. ".repeat(4)}</p></article>`,
}: {
  acquisition: SourceAcquisition;
  catalog: CatalogPersistence;
  research: ResearchIngestionPersistence;
  storyDedup: StoryDeduplicationPersistence;
  usage: UsageReportingPersistence;
  ai?: FallbackAiProvider;
  articleHtml?: string;
}) {
  const curation = new EvidenceCurationService(
    publicDns,
    { fetchPinned: async () => new Response(articleHtml, { status: 200, headers: { "content-type": "text/html" } }) },
    noSleep,
    curationGenerator,
  );
  return new TypedResearchExecutionGateway(acquisition, curation, ai, catalog, research, storyDedup, usage, () => NOW, { info() {}, warn() {} });
}

test("typed execute persists candidates, saves discovery and evidence raw content, then finishes the run", async () => {
  const calls: unknown[] = [];
  const catalog: Partial<CatalogPersistence> = {
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
  };
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() {
      calls.push("start");
      return { id: "run-1" } as never;
    },
    async createOrResumeArticleCandidate(input) {
      calls.push(["article", input.canonical_url]);
      return { id: "article-1", ...input } as never;
    },
    async saveRawContent(input) {
      calls.push(["raw", input.article_id]);
      return {} as never;
    },
    async transitionArticle() {
      throw new Error("must not transition in this happy path");
    },
    async finishSearchRun(id, details) {
      calls.push(["finish", id, details.resultCount]);
      return {} as never;
    },
    async failSearchRun() {
      calls.push("fail");
      return {} as never;
    },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() {
      calls.push("listRecentPublishedStories");
      return [];
    },
    async recordStoryDedupDecision(input) {
      calls.push(["recordStoryDedupDecision", input.relation]);
      return {} as never;
    },
  };
  const usage: UsageReportingPersistence = fakeUsage();
  const acquisition: SourceAcquisition = {
    async fetchFeed() {
      throw new Error("unused");
    },
    async fetchSourceFeed() {
      throw new Error("unused");
    },
    async fetchSource(input) {
      assert.equal(input.sourceType, "rss");
      assert.equal(input.sourceId, PRIMARY_SOURCE.id);
      return [FEED_ENTRY];
    },
    async fetchReddit() {
      throw new Error("unused");
    },
    async fetchGdelt() {
      throw new Error("unused");
    },
    async searchNews() {
      throw new Error("must not reach paid search when RSS already produced a candidate");
    },
    async discoverFeeds() {
      throw new Error("must not reach feed discovery when RSS already produced a candidate");
    },
  };

  const gateway = buildGateway({ acquisition, catalog: catalog as CatalogPersistence, research: research as ResearchIngestionPersistence, storyDedup, usage });
  const result = await gateway.execute({ input: { query: "AI news" } });

  assert.equal(result.selected.article.id, "article-1");
  assert.match(result.selected.evidenceText!, /^Extracted primary article evidence with enough length to pass extraction\./);
  assert.deepEqual(calls, [
    "start",
    ["article", "https://example.com/agent"],
    ["raw", "article-1"],
    "listRecentPublishedStories",
    ["recordStoryDedupDecision", "distinct"],
    ["raw", "article-1"],
    ["finish", "run-1", 1],
  ]);
});

test("execute never calls finishSearchRun after a transitionArticle failure — failSearchRun replaces the pending rejection", async () => {
  const transitionFailure = new Error("transition persistence failed");
  const failReplacement = new Error("failSearchRun replacement");
  let failedWith: unknown;

  // Drive transitionArticle deterministically through the story-dedup
  // "duplicate" branch (unconditional, no AI call, no policy dependency):
  // a "published story" with the exact same title/summary as the candidate
  // fingerprints identically and maxes out context similarity, guaranteeing
  // a deterministic duplicate match with zero fixture complexity.
  const fingerprint = new EvidenceCurationService(publicDns, { fetchPinned: async () => { throw new Error("must not fetch — duplicate short-circuits before extraction"); } }, noSleep)
    .storyFingerprint({ title: FEED_ENTRY.title, summary: FEED_ENTRY.summary });

  const catalog: Partial<CatalogPersistence> = {
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
  };
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() {
      return { id: "run-transition-replacement" } as never;
    },
    async createOrResumeArticleCandidate(input) {
      return { id: "transition-replacement-article", ...input } as never;
    },
    async saveRawContent() {
      return {} as never;
    },
    async transitionArticle() {
      throw transitionFailure;
    },
    async finishSearchRun() {
      throw new Error("must not finish");
    },
    async failSearchRun(_id, error) {
      failedWith = error;
      throw failReplacement;
    },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() {
      return [
        {
          article_id: "published-prior",
          title: FEED_ENTRY.title,
          feed_summary: FEED_ENTRY.summary,
          message_text: FEED_ENTRY.summary,
          telegram_channel_id: "@channel",
          telegram_message_id: 1,
          published_at: "2026-06-26T12:00:00.000Z",
          story_fingerprint: fingerprint,
        },
      ];
    },
    async recordStoryDedupDecision(input) {
      assert.equal(input.relation, "duplicate");
      return {} as never;
    },
  };
  const usage: UsageReportingPersistence = fakeUsage();
  const acquisition: SourceAcquisition = {
    async fetchFeed() {
      throw new Error("unused");
    },
    async fetchSourceFeed() {
      throw new Error("unused");
    },
    async fetchSource() {
      return [FEED_ENTRY];
    },
    async fetchReddit() {
      throw new Error("unused");
    },
    async fetchGdelt() {
      throw new Error("unused");
    },
    async searchNews() {
      throw new Error("unused");
    },
    async discoverFeeds() {
      throw new Error("unused");
    },
  };

  const gateway = buildGateway({
    acquisition,
    catalog: catalog as CatalogPersistence,
    research: research as ResearchIngestionPersistence,
    storyDedup,
    usage,
  });

  await assert.rejects(
    gateway.execute({ input: { query: "world news" } }),
    (error) => error === failReplacement,
  );
  assert.equal(failedWith, transitionFailure);
});

test("execute fails closed without any discovery sources and never starts a run", async () => {
  const calls: string[] = [];
  const catalog: Partial<CatalogPersistence> = {
    async listEnabledSources() {
      return [];
    },
  };
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() {
      calls.push("start");
      return { id: "run-empty" } as never;
    },
    async failSearchRun() {
      calls.push("fail");
      return {} as never;
    },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() {
      return [];
    },
    async recordStoryDedupDecision() {
      return {} as never;
    },
  };
  const usage: UsageReportingPersistence = fakeUsage();
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource() { throw new Error("unused"); },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    async searchNews() { throw new Error("unused"); },
    async discoverFeeds() { throw new Error("unused"); },
  };
  const ai = fakeAi({ names: [] });

  const gateway = buildGateway({ acquisition, catalog: catalog as CatalogPersistence, research: research as ResearchIngestionPersistence, storyDedup, usage, ai });

  await assert.rejects(
    gateway.execute({ input: { query: "AI news" } }),
    /No enabled news discovery sources are configured/,
  );
  // The run was started (matching legacy behaviour — the guard runs inside
  // the try block, after startSearchRun) and correctly failed, not finished.
  assert.deepEqual(calls, ["start", "fail"]);
});

test("execute rejects a pre-aborted signal before starting a run", async () => {
  const calls: string[] = [];
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() {
      calls.push("start");
      return { id: "run-aborted" } as never;
    },
  };
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource() { throw new Error("unused"); },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    async searchNews() { throw new Error("unused"); },
    async discoverFeeds() { throw new Error("unused"); },
  };
  const catalog: Partial<CatalogPersistence> = { async listEnabledSources() { throw new Error("unused"); } };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() { return {} as never; },
  };
  const usage: UsageReportingPersistence = fakeUsage();
  const gateway = buildGateway({ acquisition, catalog: catalog as CatalogPersistence, research: research as ResearchIngestionPersistence, storyDedup, usage });

  const controller = new AbortController();
  controller.abort(new Error("cancelled before start"));
  await assert.rejects(gateway.execute({ input: { query: "AI news" } }, controller.signal), /cancelled before start/);
  assert.deepEqual(calls, []);
});

test("primary_feed_summary fallback selects a primary-source candidate when extraction fails", async () => {
  const catalog: Partial<CatalogPersistence> = { async listEnabledSources() { return [PRIMARY_SOURCE]; } };
  let finished: { resultCount: number; metadata: Record<string, unknown> } | undefined;
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() { return { id: "run-primary-fallback" } as never; },
    async createOrResumeArticleCandidate(input) { return { id: "primary-fallback-article", metadata: {}, ...input } as never; },
    async saveRawContent() { return {} as never; },
    async transitionArticle() { throw new Error("must not transition — no policy exclusions configured"); },
    async finishSearchRun(id, details) { finished = details as never; return {} as never; },
    async failSearchRun() { throw new Error("must not fail"); },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() { return {} as never; },
  };
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource() { return [FEED_ENTRY]; },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    async searchNews() { throw new Error("unused"); },
    async discoverFeeds() { throw new Error("unused"); },
  };

  // A too-short article body fails EvidenceCurationService's MIN_TEXT(200)
  // check, forcing extraction to fail and the run into the fallback tiers.
  const gateway = buildGateway({
    acquisition,
    catalog: catalog as CatalogPersistence,
    research: research as ResearchIngestionPersistence,
    storyDedup,
    usage: fakeUsage(),
    articleHtml: "<article><p>short</p></article>",
  });

  const result = await gateway.execute({ input: { query: "AI news" } });
  assert.equal(result.selected.verificationStatus, "primary_source");
  assert.equal(result.selected.evidenceKind, "primary_feed_summary");
  assert.equal(result.selected.evidenceText!, FEED_ENTRY.summary);
  assert.equal(result.extractionErrors.length, 1);
  assert.equal(result.extractionErrors[0].article_id, "primary-fallback-article");
  assert.equal(finished?.metadata.selected_evidence_kind, "primary_feed_summary");
});

test("web_search_summary fallback selects a non-primary web-source candidate when extraction fails", async () => {
  const gdeltSource: SourceWithTopics = {
    ...PRIMARY_SOURCE,
    id: "source-gdelt",
    is_primary: false,
    source_type: "api",
    feed_url: "https://api.gdeltproject.org/api/v2/doc/doc",
  };
  const webEntry = {
    title: "Independent outlet covers the story",
    canonicalUrl: "https://unrelated-publisher.example/story",
    author: null,
    publishedAt: "2026-06-26T18:00:00Z",
    summary: "An unaffiliated publisher's account of the same event.",
    contentHash: "gdelt-hash",
    publisher: "unrelated-publisher.example",
    discoveryUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
    discoveryKind: "gdelt" as const,
  };
  const catalog: Partial<CatalogPersistence> = { async listEnabledSources() { return [gdeltSource]; } };
  let finished: { resultCount: number; metadata: Record<string, unknown> } | undefined;
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() { return { id: "run-web-fallback" } as never; },
    async createOrResumeArticleCandidate(input) { return { id: "web-fallback-article", metadata: {}, ...input } as never; },
    async saveRawContent() { return {} as never; },
    async transitionArticle() { throw new Error("must not transition — no policy exclusions configured"); },
    async finishSearchRun(id, details) { finished = details as never; return {} as never; },
    async failSearchRun() { throw new Error("must not fail"); },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() { return {} as never; },
  };
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource(input) {
      assert.equal(input.sourceType, "gdelt");
      return [webEntry];
    },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    async searchNews() { throw new Error("unused"); },
    async discoverFeeds() { throw new Error("unused"); },
  };

  const gateway = buildGateway({
    acquisition,
    catalog: catalog as CatalogPersistence,
    research: research as ResearchIngestionPersistence,
    storyDedup,
    usage: fakeUsage(),
    articleHtml: "<article><p>short</p></article>",
  });

  const result = await gateway.execute({ input: { query: "AI news" } });
  assert.equal(result.selected.verificationStatus, "web_search_summary");
  assert.equal(result.selected.evidenceKind, "web_search_summary");
  assert.equal(result.selected.evidenceText!, webEntry.summary);
  assert.equal(finished?.metadata.selected_evidence_kind, "web_search_summary");
});

test("excluded-topic policy deterministically blocks a conflict-event title at the discovery stage and finishes the run with zero results", async () => {
  const catalog: Partial<CatalogPersistence> = { async listEnabledSources() { return [PRIMARY_SOURCE]; } };
  let finished: { resultCount: number; metadata: Record<string, unknown> } | undefined;
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() { return { id: "run-policy-blocked" } as never; },
    async createOrResumeArticleCandidate() { throw new Error("must not persist a candidate blocked at discovery"); },
    async finishSearchRun(id, details) { finished = details as never; return {} as never; },
    async failSearchRun() { throw new Error("must not fail — this is a clean policy-filtered terminal state"); },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() { return {} as never; },
  };
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource() {
      // Matches the deterministic conflict-event regex in
      // excluded-topic-policy.js — blocked without any AI call.
      return [{ ...FEED_ENTRY, title: "Missile strike kills dozens in border town" }];
    },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    // ranked.length is 0 after the discovery-stage block, so execute()
    // legitimately proceeds through the feed-discovery and news-search
    // fallback stages (matching research.js) before reaching the terminal
    // no-candidates check — both must resolve empty, not throw.
    async searchNews() { return { items: [], provider: "openai", model: null, usageEvents: [] }; },
    async discoverFeeds() { return { status: "unsupported", sources: [], usageEvents: [] }; },
  };
  const ai = fakeAi(); // never called — the block is deterministic, not semantic

  const gateway = buildGateway({ acquisition, catalog: catalog as CatalogPersistence, research: research as ResearchIngestionPersistence, storyDedup, usage: fakeUsage(), ai });

  await assert.rejects(
    gateway.execute({
      input: {
        query: "AI news",
        newsSettings: { languageCode: "en", topicCodes: ["ai"], customTopics: [], excludedTopicCodes: ["war_conflict"], version: 1 },
      },
    }),
    /No recent news candidates remained after excluded-topic policy/,
  );
  assert.equal(finished?.resultCount, 0);
  assert.equal(finished?.metadata.reason, "excluded_topic_policy");
  assert.equal(finished?.metadata.terminal_stage, "acquisition");
});

test("NoResearchCandidatesError is thrown, and failSearchRun (not finishSearchRun) records the run, when no candidates persist", async () => {
  const calls: string[] = [];
  const catalog: Partial<CatalogPersistence> = { async listEnabledSources() { return [PRIMARY_SOURCE]; } };
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() { return { id: "run-empty-candidates" } as never; },
    async createOrResumeArticleCandidate() { return null; },
    async finishSearchRun() { throw new Error("must not finish"); },
    async failSearchRun(_id, error) {
      calls.push((error as Error).constructor.name);
      return {} as never;
    },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() { return {} as never; },
  };
  const usage: UsageReportingPersistence = fakeUsage();
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource() { return [FEED_ENTRY]; },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    async searchNews() { throw new Error("unused"); },
    async discoverFeeds() { throw new Error("unused"); },
  };

  const gateway = buildGateway({ acquisition, catalog: catalog as CatalogPersistence, research: research as ResearchIngestionPersistence, storyDedup, usage });
  await assert.rejects(gateway.execute({ input: { query: "AI news" } }), NoResearchCandidatesError);
  assert.deepEqual(calls, ["NoResearchCandidatesError"]);
});

test("AI feed-discovery fallback supplies a candidate when no configured source produces one", async () => {
  const discoveredSource = { id: null, name: "discovered.example", homepage_url: "https://discovered.example", feed_url: "https://discovered.example/feed", source_type: "rss", reliability_score: 70, is_primary: false };
  let discoverFeedsCalled = false;
  const catalog: Partial<CatalogPersistence> = { async listEnabledSources() { return []; } };
  let finished: { resultCount: number } | undefined;
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() { return { id: "run-feed-discovery" } as never; },
    async createOrResumeArticleCandidate(input) {
      assert.equal(input.metadata?.discovery_kind, "discovered_rss_feed");
      return { id: "discovered-article", metadata: {}, ...input } as never;
    },
    async saveRawContent() { return {} as never; },
    async finishSearchRun(_id, details) { finished = details as never; return {} as never; },
    async failSearchRun() { throw new Error("must not fail"); },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() { return {} as never; },
  };
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource() { throw new Error("no configured source should be fanned out over — listEnabledSources is empty"); },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    async searchNews() { throw new Error("must not reach paid search once feed discovery already produced a candidate"); },
    async discoverFeeds(input) {
      discoverFeedsCalled = true;
      assert.deepEqual(input.newsSettings, { languageCode: "en", topicCodes: ["ai"], customTopics: [] });
      return { status: "completed", provider: "openai", model: "test", sources: [{ source: discoveredSource, entries: [FEED_ENTRY] }], usageEvents: [] };
    },
  };

  const gateway = buildGateway({ acquisition, catalog: catalog as CatalogPersistence, research: research as ResearchIngestionPersistence, storyDedup, usage: fakeUsage() });
  const result = await gateway.execute({ input: { query: "AI news" } });

  assert.ok(discoverFeedsCalled);
  assert.equal(result.selected.article.id, "discovered-article");
  assert.equal(finished?.resultCount, 1);
});

test("AI news-search fallback supplies a candidate when feed discovery also yields nothing, and records its usage", async () => {
  // Regression test: this call goes through the raw AI provider directly
  // (this.ai.searchNews), bypassing SourceAcquisitionGateway.searchNews —
  // the one place that would otherwise record usage internally. An earlier
  // version of the gateway assumed (incorrectly, per its own comment) that
  // usage was already being recorded somewhere and silently dropped it.
  let searchNewsCalled = false;
  const recordedUsage: unknown[] = [];
  const catalog: Partial<CatalogPersistence> = { async listEnabledSources() { return []; } };
  let finished: { resultCount: number } | undefined;
  const research: Partial<ResearchIngestionPersistence> = {
    async startSearchRun() { return { id: "run-news-search" } as never; },
    async createOrResumeArticleCandidate(input) {
      assert.match(input.canonical_url, /^https:\/\/web-result\.example\/story/);
      return { id: "web-search-article", metadata: {}, ...input } as never;
    },
    async saveRawContent() { return {} as never; },
    async finishSearchRun(_id, details) { finished = details as never; return {} as never; },
    async failSearchRun() { throw new Error("must not fail"); },
  };
  const storyDedup: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() { return {} as never; },
  };
  const acquisition: SourceAcquisition = {
    async fetchFeed() { throw new Error("unused"); },
    async fetchSourceFeed() { throw new Error("unused"); },
    async fetchSource() { throw new Error("no configured source — listEnabledSources is empty"); },
    async fetchReddit() { throw new Error("unused"); },
    async fetchGdelt() { throw new Error("unused"); },
    async searchNews() { throw new Error("unused — the gateway calls the AI provider's searchNews directly, not the acquisition port's"); },
    async discoverFeeds() { return { status: "unsupported", sources: [], usageEvents: [] }; },
  };
  const ai = fakeAi({
    async searchNews(input) {
      searchNewsCalled = true;
      assert.equal((input as { query: string }).query, "AI news");
      return {
        provider: "openai",
        items: [{ url: "https://web-result.example/story", title: "Web search result", summary: "A summary from paid web search.", publishedAt: "2026-06-26T18:00:00Z" }],
        usageEvents: [{ provider: "openai", model: "test", operation: "news_search", inputTokens: 42 }],
      } as never;
    },
  });
  const usage: UsageReportingPersistence = {
    ...fakeUsage(),
    async recordAiUsage(input) {
      recordedUsage.push(input);
      return {} as never;
    },
  };

  const gateway = buildGateway({ acquisition, catalog: catalog as CatalogPersistence, research: research as ResearchIngestionPersistence, storyDedup, usage, ai });
  const result = await gateway.execute({ input: { query: "AI news" } });

  assert.ok(searchNewsCalled);
  assert.equal(result.selected.article.id, "web-search-article");
  assert.equal(result.selected.discoveryKind, "openai_web_search");
  assert.equal(finished?.resultCount, 1);
  assert.equal(recordedUsage.length, 1);
  assert.equal((recordedUsage[0] as { provider: string }).provider, "openai");
  assert.equal((recordedUsage[0] as { operation: string }).operation, "news_search");
  assert.equal((recordedUsage[0] as { inputTokens: number }).inputTokens, 42);
  assert.equal((recordedUsage[0] as { searchRunId: string }).searchRunId, "run-news-search");
});
