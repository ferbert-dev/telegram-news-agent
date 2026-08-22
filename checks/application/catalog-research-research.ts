import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";

import type { CatalogPersistence } from "../../src/catalog/catalog-persistence.js";
import { CatalogPersistenceModule } from "../../src/catalog/catalog-persistence.module.js";
import { CATALOG_PERSISTENCE } from "../../src/catalog/catalog-persistence.tokens.js";
import { ResearchService } from "../../src/research/application/research.service.js";
import { RunResearchUseCase } from "../../src/research/application/run-research.use-case.js";
import {
  LegacyResearchExecutionGateway,
  type LegacyRunResearchInput,
} from "../../src/research/legacy-research-execution.gateway.js";
import { LegacyResearchExecutionGatewayModule } from "../../src/research/legacy-research-execution.module.js";
import { ResearchApplicationModule } from "../../src/research/research-application.module.js";
import type {
  ResearchAiGateway,
  ResearchExecutionGateway,
  ResearchFetchGateway,
  ResearchSearchGateway,
  RunResearchResult,
} from "../../src/research/research-gateway.contracts.js";
import {
  RESEARCH_AI_GATEWAY,
  RESEARCH_EXECUTION_GATEWAY,
  RESEARCH_FETCH_GATEWAY,
  RESEARCH_SEARCH_GATEWAY,
} from "../../src/research/research-gateway.tokens.js";
import type {
  ArticleRow,
  RawContentRow,
  ResearchIngestionPersistence,
  SearchRunRow,
} from "../../src/research/research-persistence.contracts.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "../../src/research/research-persistence.tokens.js";
import { ResearchPersistenceModule } from "../../src/research/research-persistence.module.js";
import type { StoryDeduplicationPersistence } from "../../src/story-deduplication/story-deduplication.contracts.js";
import { StoryDeduplicationPersistenceModule } from "../../src/story-deduplication/story-deduplication-persistence.module.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "../../src/story-deduplication/story-deduplication.tokens.js";
import type {
  AiUsageEventRow,
  RecordAiUsageInput,
  UsageReportingPersistence,
} from "../../src/usage/usage-persistence.contracts.js";
import { UsagePersistenceModule } from "../../src/usage/usage-persistence.module.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../src/usage/usage-persistence.tokens.js";

const RUN: SearchRunRow = {
  id: "00000000-0000-4000-8000-000000000001",
  query: "science",
  status: "running",
  source_id: null,
  started_at: "2026-08-22T08:00:00.000Z",
  finished_at: null,
  result_count: 0,
  error: null,
  metadata: {},
};
const SOURCE_ID = "00000000-0000-4000-8000-000000000003";
const ARTICLE: ArticleRow = {
  id: "00000000-0000-4000-8000-000000000002",
  source_id: SOURCE_ID,
  search_run_id: RUN.id,
  canonical_url: "https://example.test/story",
  title: "Story",
  author: null,
  published_at: "2026-08-22T07:00:00.000Z",
  discovered_at: RUN.started_at,
  content_hash: "article-hash",
  status: "discovered",
  metadata: {},
  created_at: RUN.started_at,
  updated_at: RUN.started_at,
};
const RAW: RawContentRow = {
  id: "00000000-0000-4000-8000-000000000004",
  article_id: ARTICLE.id,
  content: "Evidence",
  content_type: "text",
  language_code: "en",
  fetched_at: RUN.started_at,
  extractor: "test",
  content_hash: "raw-hash",
  metadata: {},
  created_at: RUN.started_at,
};
const USAGE: AiUsageEventRow = {
  id: "00000000-0000-4000-8000-000000000005",
  provider: "openai",
  provider_response_id: "response-1",
  model: "model",
  operation: "research",
  telegram_channel_id: null,
  search_run_id: RUN.id,
  article_id: ARTICLE.id,
  input_tokens: 10,
  cached_input_tokens: 0,
  output_tokens: 2,
  reasoning_tokens: 0,
  web_search_calls: 1,
  estimated_cost_usd: "0.01000000",
  pricing_snapshot: null,
  created_at: RUN.started_at,
};
const SOURCE = {
  id: SOURCE_ID,
  name: "Example",
  homepage_url: "https://example.test",
  feed_url: "https://example.test/feed.xml",
  source_type: "rss",
  reliability_score: 90,
  enabled: true,
  last_checked_at: null,
  created_at: RUN.started_at,
  updated_at: RUN.started_at,
  is_primary: true,
  last_success_at: null,
  last_failed_at: null,
  consecutive_failures: 0,
  last_error_code: null,
  disabled_until: null,
  discovered_by: "seed",
  discovery_metadata: {},
  topic_codes: ["science"],
};
const RESULT: RunResearchResult = {
  runId: RUN.id,
  selected: {
    article: ARTICLE,
    source: SOURCE,
    canonicalUrl: ARTICLE.canonical_url,
    title: ARTICLE.title,
    summary: "Summary",
    author: null,
    publishedAt: ARTICLE.published_at,
    contentHash: ARTICLE.content_hash ?? "",
    score: 100,
    evidenceText: RAW.content,
  },
  candidates: [],
  feedErrors: [],
  extractionErrors: [],
};
RESULT.candidates.push(RESULT.selected);

function fixturePorts() {
  const catalog: CatalogPersistence = {
    async listEnabledSources() { return [SOURCE]; },
    async listEnabledArticleTags() { return []; },
    async listSourceHealth() { return [SOURCE]; },
    async upsertSource() { return SOURCE; },
    async setSourceEnabled() { return SOURCE; },
    async markSourceChecked() { return SOURCE; },
    async markSourceFetchSuccess() { return SOURCE; },
    async markSourceFetchFailure() { return SOURCE; },
    async claimSourceDiscovery() { return true; },
    async completeSourceDiscovery() { return true; },
    async upsertDiscoveredSource() { return SOURCE; },
  };
  const research: ResearchIngestionPersistence = {
    async startSearchRun() { return RUN; },
    async finishSearchRun() { return { ...RUN, status: "completed" }; },
    async failSearchRun() { return { ...RUN, status: "failed" }; },
    async createOrResumeArticleCandidate() { return ARTICLE; },
    async saveRawContent() { return RAW; },
    async transitionArticle() { return ARTICLE; },
    async replaceArticleTopics() { return []; },
  };
  const story: StoryDeduplicationPersistence = {
    async listRecentPublishedStories() { return []; },
    async recordStoryDedupDecision() {
      return {
        article_id: ARTICLE.id,
        story_fingerprint: "fingerprint",
        relation: "distinct",
        duplicate_of_article_id: null,
        confidence: "1",
        reason: null,
        decision_source: "deterministic",
        metadata: {},
        decided_at: RUN.started_at,
        updated_at: RUN.started_at,
      };
    },
  };
  const usage: UsageReportingPersistence = {
    async recordAiUsage() { return USAGE; },
    async getDailyUsageDashboard() { throw new Error("unused"); },
  };
  return { catalog, research, story, usage };
}

test("RunResearchUseCase delegates exactly once and preserves result identity", async () => {
  const signal = new AbortController().signal;
  const input = {
    query: "science",
    keywords: ["space"],
    windowHours: 24,
    newsSettings: { channelId: "channel" },
  };
  const calls: unknown[][] = [];
  const gateway: ResearchExecutionGateway = {
    async execute(...args) { calls.push(args); return RESULT; },
  };

  const result = await new RunResearchUseCase(gateway).execute(input, signal);

  assert.equal(result, RESULT);
  assert.deepEqual(calls, [[{ input }, signal]]);
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, RunResearchUseCase),
    [{ index: 0, param: RESEARCH_EXECUTION_GATEWAY }],
  );
});

test("RunResearchUseCase preserves gateway error identity", async () => {
  const failure = new Error("provider unavailable");
  const useCase = new RunResearchUseCase({
    async execute() { throw failure; },
  });
  await assert.rejects(
    useCase.execute({ query: "science" }),
    (error) => error === failure,
  );
});

test("LegacyResearchExecutionGateway exposes every required narrow effect and returns the exact legacy result", async () => {
  const ports = fixturePorts();
  const provider = { searchNews: async () => ({ items: [] }) };
  const fixedNow = new Date("2026-08-22T08:00:00.000Z");
  let captured: LegacyRunResearchInput | undefined;
  const gateway = new LegacyResearchExecutionGateway(
    ports.catalog,
    ports.research,
    ports.story,
    ports.usage,
    {
      discoveryProvider: provider,
      now: () => fixedNow,
      runResearchImpl: async (input) => {
        captured = input;
        return RESULT;
      },
    },
  );

  const result = await gateway.execute({
    input: {
      query: "science",
      keywords: ["space"],
      windowHours: 12,
      newsSettings: { topicCodes: ["science"] },
    },
  });

  assert.equal(result, RESULT);
  assert.ok(captured);
  assert.equal(captured.discoveryProvider, provider);
  assert.equal(captured.now, fixedNow);
  assert.equal(captured.query, "science");
  assert.deepEqual(captured.keywords, ["space"]);
  assert.equal(captured.windowHours, 12);
  assert.deepEqual(captured.newsSettings, { topicCodes: ["science"] });
  assert.deepEqual(Object.keys(captured.repository).sort(), [
    "claimSourceDiscovery",
    "completeSourceDiscovery",
    "createOrResumeArticleCandidate",
    "failSearchRun",
    "finishSearchRun",
    "listEnabledSources",
    "listRecentPublishedStories",
    "markSourceChecked",
    "markSourceFetchFailure",
    "markSourceFetchSuccess",
    "recordAiUsage",
    "recordStoryDedupDecision",
    "saveRawContent",
    "startSearchRun",
    "transitionArticle",
    "upsertDiscoveredSource",
  ]);
  assert.equal(await captured.repository.startSearchRun({ query: "x" }), RUN);
  assert.equal(await captured.repository.createOrResumeArticleCandidate({
    source_id: ARTICLE.source_id,
    search_run_id: RUN.id,
    canonical_url: ARTICLE.canonical_url,
    title: ARTICLE.title,
    author: null,
    published_at: null,
    content_hash: ARTICLE.content_hash,
  }), ARTICLE);
  assert.equal(await captured.repository.saveRawContent({
    article_id: ARTICLE.id,
    content: RAW.content,
    content_hash: RAW.content_hash,
  }), RAW);
  assert.equal(await captured.repository.claimSourceDiscovery("topic"), true);
  assert.equal(await captured.repository.recordAiUsage({
    provider: "openai",
    providerResponseId: "response-1",
    model: "model",
    operation: "research",
  }), USAGE);
});

test("LegacyResearchExecutionGateway rejects a pre-aborted signal before any legacy effect", async () => {
  const ports = fixturePorts();
  const controller = new AbortController();
  const reason = new Error("cancelled before start");
  controller.abort(reason);
  let called = false;
  const gateway = new LegacyResearchExecutionGateway(
    ports.catalog,
    ports.research,
    ports.story,
    ports.usage,
    {
      discoveryProvider: {},
      runResearchImpl: async () => { called = true; return RESULT; },
    },
  );

  await assert.rejects(
    gateway.execute({ input: { query: "science" } }, controller.signal),
    (error) => error === reason,
  );
  assert.equal(called, false);
});

test("LegacyResearchExecutionGatewayModule binds the exact Symbol through its injected factory", async () => {
  const ports = fixturePorts();
  let called = false;
  const module = LegacyResearchExecutionGatewayModule.register({
    discoveryProvider: {},
    runResearchImpl: async () => { called = true; return RESULT; },
  });
  const provider = (module.providers ?? [])[0] as {
    provide: symbol;
    inject: symbol[];
    useFactory: (...args: unknown[]) => ResearchExecutionGateway;
  };
  assert.equal(provider.provide, RESEARCH_EXECUTION_GATEWAY);
  assert.deepEqual(provider.inject, [
    CATALOG_PERSISTENCE,
    RESEARCH_INGESTION_PERSISTENCE,
    STORY_DEDUPLICATION_PERSISTENCE,
    USAGE_REPORTING_PERSISTENCE,
  ]);
  const gateway = provider.useFactory(
    ports.catalog,
    ports.research,
    ports.story,
    ports.usage,
  );
  assert.equal(
    await gateway.execute({ input: { query: "science" } }),
    RESULT,
  );
  assert.equal(called, true);
  assert.deepEqual(module.imports, [
    CatalogPersistenceModule,
    ResearchPersistenceModule,
    StoryDeduplicationPersistenceModule,
    UsagePersistenceModule,
  ]);
  assert.deepEqual(module.exports, [RESEARCH_EXECUTION_GATEWAY]);
});

test("ResearchService preserves persistence DTOs and delegates execution through the use case", async () => {
  const ports = fixturePorts();
  const usageInput: RecordAiUsageInput = {
    provider: "openai",
    providerResponseId: "response-1",
    model: "model",
    operation: "research",
  };
  const runUseCase = new RunResearchUseCase({
    async execute() { return RESULT; },
  });
  const service = new ResearchService(ports.research, ports.usage, runUseCase);

  assert.equal(await service.runResearch({ query: "science" }), RESULT);
  assert.equal(await service.startSearchRun({ query: "science" }), RUN);
  assert.equal(await service.createOrResumeArticleCandidate({
    source_id: ARTICLE.source_id,
    search_run_id: RUN.id,
    canonical_url: ARTICLE.canonical_url,
    title: ARTICLE.title,
    author: null,
    published_at: null,
    content_hash: ARTICLE.content_hash,
  }), ARTICLE);
  assert.equal(await service.recordAiUsage(usageInput), USAGE);
});

test("ResearchApplicationModule keeps transport-neutral gateways replaceable", () => {
  const ai: ResearchAiGateway = {
    async generate() { return { output: {}, usageEvents: [] }; },
  };
  const search: ResearchSearchGateway = {
    async search() { return { items: [], usageEvents: [] }; },
  };
  const fetch: ResearchFetchGateway = {
    async fetch(request) {
      return {
        finalUrl: request.url,
        content: "evidence",
        contentType: "text",
        contentHash: "hash",
      };
    },
  };
  const execution: ResearchExecutionGateway = {
    async execute() { return RESULT; },
  };
  const module = ResearchApplicationModule.register({
    ai,
    search,
    fetch,
    execution,
  });
  const providers = module.providers as Array<
    { provide?: symbol; useValue?: unknown } | Function
  >;
  assert.deepEqual(
    providers.slice(0, 4).map((provider) =>
      typeof provider === "function" ? null : provider.provide,
    ),
    [
      RESEARCH_AI_GATEWAY,
      RESEARCH_SEARCH_GATEWAY,
      RESEARCH_FETCH_GATEWAY,
      RESEARCH_EXECUTION_GATEWAY,
    ],
  );
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, ResearchService),
    [
      { index: 2, param: RunResearchUseCase },
      { index: 1, param: USAGE_REPORTING_PERSISTENCE },
      { index: 0, param: RESEARCH_INGESTION_PERSISTENCE },
    ],
  );
});
