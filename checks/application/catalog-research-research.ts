import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";

import type { CatalogPersistence } from "../../src/catalog/catalog-persistence.js";
import { CatalogPersistenceModule } from "../../src/catalog/catalog-persistence.module.js";
import { CATALOG_PERSISTENCE } from "../../src/catalog/catalog-persistence.tokens.js";
import { ResearchService } from "../../src/research/application/research.service.js";
import { RunResearchUseCase } from "../../src/research/application/run-research.use-case.js";
import { ResearchApplicationModule } from "../../src/research/research-application.module.js";
import type {
  ResearchAiGateway,
  ResearchExecutionGateway,
  ResearchFetchGateway,
  ResearchSearchGateway,
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
import type {
  AiUsageEventRow,
  RecordAiUsageInput,
  UsageReportingPersistence,
} from "../../src/usage/usage-persistence.contracts.js";
import { UsagePersistenceModule } from "../../src/usage/usage-persistence.module.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../src/usage/usage-persistence.tokens.js";

const RUN: SearchRunRow = {
  id: "run-1",
  query: "science",
  status: "running",
  source_id: null,
  started_at: "2026-08-09T08:00:00.000Z",
  finished_at: null,
  result_count: 0,
  error: null,
  metadata: { mode: "test" },
};
const COMPLETED_RUN: SearchRunRow = {
  ...RUN,
  status: "completed",
  finished_at: "2026-08-09T08:01:00.000Z",
  result_count: 1,
};
const ARTICLE: ArticleRow = {
  id: "article-1",
  source_id: "source-1",
  search_run_id: RUN.id,
  canonical_url: "https://example.test/story",
  title: "Story",
  author: null,
  published_at: null,
  discovered_at: "2026-08-09T08:00:00.000Z",
  content_hash: "article-hash",
  status: "discovered",
  metadata: {},
  created_at: "2026-08-09T08:00:00.000Z",
  updated_at: "2026-08-09T08:00:00.000Z",
};
const RAW: RawContentRow = {
  id: "raw-1",
  article_id: ARTICLE.id,
  content: "Evidence",
  content_type: "text",
  language_code: null,
  fetched_at: "2026-08-09T08:00:00.000Z",
  extractor: "future-adapter",
  content_hash: "raw-hash",
  metadata: {},
  created_at: "2026-08-09T08:00:00.000Z",
};
const USAGE: AiUsageEventRow = {
  id: "usage-1",
  provider: "openai",
  provider_response_id: "response-1",
  model: "model",
  operation: "research",
  telegram_channel_id: null,
  search_run_id: RUN.id,
  article_id: null,
  input_tokens: 10,
  cached_input_tokens: 0,
  output_tokens: 2,
  reasoning_tokens: 0,
  web_search_calls: 1,
  estimated_cost_usd: "0.01000000",
  pricing_snapshot: null,
  created_at: "2026-08-09T08:00:00.000Z",
};

const CATALOG = {
  async listEnabledSources() { return []; },
} as unknown as CatalogPersistence;

function unusedDashboard(): ReturnType<UsageReportingPersistence["getDailyUsageDashboard"]> {
  throw new Error("dashboard is outside this slice");
}

test("RunResearchUseCase preserves signal and usage identity, skips null candidates, writes raw content, and finishes the run", async () => {
  const calls: unknown[] = [];
  const startInput = {
    query: "science",
    metadata: { scope: "broad" },
  };
  const articleInput = {
    source_id: "source-1",
    search_run_id: RUN.id,
    canonical_url: ARTICLE.canonical_url,
    title: ARTICLE.title,
    author: null,
    published_at: null,
    content_hash: ARTICLE.content_hash,
    metadata: {},
  };
  const skippedArticleInput = {
    ...articleInput,
    canonical_url: "https://example.test/existing",
    title: "Existing",
  };
  const rawInput = {
    content: RAW.content,
    content_type: RAW.content_type,
    language_code: RAW.language_code,
    extractor: RAW.extractor,
    content_hash: RAW.content_hash,
    metadata: RAW.metadata,
  };
  const skippedRawInput = { ...rawInput, content_hash: "must-not-write" };
  const usageInput: RecordAiUsageInput = {
    provider: "openai",
    providerResponseId: "response-1",
    model: "model",
    operation: "research",
    searchRunId: RUN.id,
    inputTokens: 10,
    outputTokens: 2,
    webSearchCalls: 1,
  };
  const finishMetadata = { selected_article_id: ARTICLE.id };
  const persistence: ResearchIngestionPersistence = {
    async startSearchRun(input) {
      calls.push(["start", input]);
      return RUN;
    },
    async finishSearchRun(id, input) {
      calls.push(["finish", id, input]);
      return COMPLETED_RUN;
    },
    async failSearchRun(id, error) {
      calls.push(["fail", id, error]);
      throw new Error("must not fail");
    },
    async createOrResumeArticleCandidate(input) {
      calls.push(["candidate", input]);
      return input === skippedArticleInput ? null : ARTICLE;
    },
    async saveRawContent(input) {
      calls.push(["raw", input]);
      return RAW;
    },
    async transitionArticle() {
      throw new Error("unused");
    },
    async replaceArticleTopics() {
      throw new Error("unused");
    },
  };
  const usage: UsageReportingPersistence = {
    async recordAiUsage(input) {
      calls.push(["usage", input]);
      return USAGE;
    },
    getDailyUsageDashboard: unusedDashboard,
  };
  const controller = new AbortController();
  let gatewayRequest: unknown;
  let gatewaySignal: AbortSignal | undefined;
  const executionResult = {
    usageEvents: [usageInput],
    candidates: [
      { article: articleInput, rawContents: [rawInput] },
      { article: skippedArticleInput, rawContents: [skippedRawInput] },
    ],
    finish: { metadata: finishMetadata },
    output: { selected: ARTICLE.id },
  };
  const gateway: ResearchExecutionGateway = {
    async execute(request, signal) {
      gatewayRequest = request;
      gatewaySignal = signal;
      return executionResult;
    },
  };
  const useCase = new RunResearchUseCase(persistence, CATALOG, usage, gateway);

  const result = await useCase.execute(startInput, controller.signal);

  assert.equal((gatewayRequest as { searchRun: SearchRunRow }).searchRun, RUN);
  assert.equal((gatewayRequest as { input: typeof startInput }).input, startInput);
  assert.deepEqual((gatewayRequest as { sources: unknown[] }).sources, []);
  assert.equal(gatewaySignal, controller.signal);
  assert.equal((calls[1] as unknown[])[1], usageInput);
  assert.equal(usageInput.providerResponseId, "response-1");
  assert.equal((calls[2] as unknown[])[1], articleInput);
  assert.deepEqual((calls[3] as unknown[])[1], {
    ...rawInput,
    article_id: ARTICLE.id,
  });
  assert.equal((calls[4] as unknown[])[1], skippedArticleInput);
  assert.equal(
    calls.filter(
      (call) => Array.isArray(call) && call[0] === "raw",
    ).length,
    1,
  );
  const finishInput = (calls[5] as unknown[])[2] as {
    resultCount: number;
    metadata: unknown;
  };
  assert.equal(finishInput.resultCount, 1);
  assert.equal(finishInput.metadata, finishMetadata);
  assert.equal(result.run, RUN);
  assert.equal(result.completedRun, COMPLETED_RUN);
  assert.equal(result.execution, executionResult);
  assert.equal(result.usageEvents[0], USAGE);
  assert.equal(result.candidates[0].article, ARTICLE);
  assert.equal(result.candidates[0].rawContents[0], RAW);
});

test("RunResearchUseCase fails the started run and rethrows the original gateway error identity", async () => {
  const failure = new Error("provider unavailable");
  let failedRunId: string | undefined;
  let failedError: unknown;
  const persistence: ResearchIngestionPersistence = {
    async startSearchRun() { return RUN; },
    async finishSearchRun() { throw new Error("must not finish"); },
    async failSearchRun(id, error) {
      failedRunId = id;
      failedError = error;
      return { ...RUN, status: "failed", error: failure.message };
    },
    async createOrResumeArticleCandidate() { throw new Error("unused"); },
    async saveRawContent() { throw new Error("unused"); },
    async transitionArticle() { throw new Error("unused"); },
    async replaceArticleTopics() { throw new Error("unused"); },
  };
  const usage: UsageReportingPersistence = {
    async recordAiUsage() { throw new Error("unused"); },
    getDailyUsageDashboard: unusedDashboard,
  };
  const gateway: ResearchExecutionGateway = {
    async execute() { throw failure; },
  };
  const useCase = new RunResearchUseCase(persistence, CATALOG, usage, gateway);

  await assert.rejects(
    useCase.execute({ query: "science" }),
    (error) => error === failure,
  );
  assert.equal(failedRunId, RUN.id);
  assert.equal(failedError, failure);
});

test("RunResearchUseCase preserves legacy replacement semantics when failSearchRun itself rejects", async () => {
  const executionFailure = new Error("provider unavailable");
  const failWriteFailure = new Error("failed-run persistence unavailable");
  const persistence: ResearchIngestionPersistence = {
    async startSearchRun() { return RUN; },
    async finishSearchRun() { throw new Error("must not finish"); },
    async failSearchRun(_id, error) {
      assert.equal(error, executionFailure);
      throw failWriteFailure;
    },
    async createOrResumeArticleCandidate() { throw new Error("unused"); },
    async saveRawContent() { throw new Error("unused"); },
    async transitionArticle() { throw new Error("unused"); },
    async replaceArticleTopics() { throw new Error("unused"); },
  };
  const usage: UsageReportingPersistence = {
    async recordAiUsage() { throw new Error("unused"); },
    getDailyUsageDashboard: unusedDashboard,
  };
  const gateway: ResearchExecutionGateway = {
    async execute() { throw executionFailure; },
  };

  await assert.rejects(
    new RunResearchUseCase(persistence, CATALOG, usage, gateway).execute({
      query: "science",
    }),
    (error) => error === failWriteFailure,
  );
});

test("RunResearchUseCase keeps usage writes best effort and continues after an individual accounting failure", async () => {
  const firstUsage: RecordAiUsageInput = {
    provider: "openai",
    providerResponseId: "response-failed",
    model: "model",
    operation: "research",
  };
  const secondUsage: RecordAiUsageInput = {
    provider: "gemini",
    providerResponseId: "response-recorded",
    model: "model",
    operation: "research",
  };
  const attempted: RecordAiUsageInput[] = [];
  let finished = false;
  const persistence: ResearchIngestionPersistence = {
    async startSearchRun() { return RUN; },
    async finishSearchRun() {
      finished = true;
      return { ...COMPLETED_RUN, result_count: 0 };
    },
    async failSearchRun() { throw new Error("usage telemetry must not fail the run"); },
    async createOrResumeArticleCandidate() { throw new Error("unused"); },
    async saveRawContent() { throw new Error("unused"); },
    async transitionArticle() { throw new Error("unused"); },
    async replaceArticleTopics() { throw new Error("unused"); },
  };
  const usage: UsageReportingPersistence = {
    async recordAiUsage(input) {
      attempted.push(input);
      if (input === firstUsage) throw new Error("usage database offline");
      return { ...USAGE, provider: "gemini", provider_response_id: "response-recorded" };
    },
    getDailyUsageDashboard: unusedDashboard,
  };
  const gateway: ResearchExecutionGateway = {
    async execute() {
      return {
        candidates: [],
        usageEvents: [firstUsage, secondUsage],
        finish: {},
      };
    },
  };

  const result = await new RunResearchUseCase(
    persistence,
    CATALOG,
    usage,
    gateway,
  ).execute({ query: "science" });

  assert.deepEqual(attempted, [firstUsage, secondUsage]);
  assert.equal(attempted[0], firstUsage);
  assert.equal(attempted[1], secondUsage);
  assert.equal(finished, true);
  assert.equal(result.usageEvents.length, 1);
  assert.equal(result.usageEvents[0].provider_response_id, "response-recorded");
});

test("ResearchService preserves exact persistence DTO, null, and error identity", async () => {
  const calls: unknown[] = [];
  const failure = new Error("transition conflict");
  const FAILED_RUN = { ...RUN, status: "failed" as const };
  const persistence: ResearchIngestionPersistence = {
    async startSearchRun(input) { calls.push(["start", input]); return RUN; },
    async finishSearchRun(id, input) { calls.push(["finish", id, input]); return COMPLETED_RUN; },
    async failSearchRun(id, error) { calls.push(["fail", id, error]); return FAILED_RUN; },
    async createOrResumeArticleCandidate(input) { calls.push(["candidate", input]); return null; },
    async saveRawContent(input) { calls.push(["raw", input]); return RAW; },
    async transitionArticle() { throw failure; },
    async replaceArticleTopics(input) { calls.push(["topics", input]); return []; },
  };
  const usageInput: RecordAiUsageInput = {
    provider: "openai",
    providerResponseId: "response-identity",
    model: "model",
    operation: "research",
  };
  const usage: UsageReportingPersistence = {
    async recordAiUsage(input) { calls.push(["usage", input]); return USAGE; },
    getDailyUsageDashboard: unusedDashboard,
  };
  const runUseCase = { execute: async () => ({ run: RUN }) } as unknown as RunResearchUseCase;
  const service = new ResearchService(persistence, usage, runUseCase);
  const candidateInput = {
    source_id: null,
    search_run_id: RUN.id,
    canonical_url: ARTICLE.canonical_url,
    title: ARTICLE.title,
    author: null,
    published_at: null,
    content_hash: null,
  };
  const rawInput = {
    article_id: ARTICLE.id,
    content: RAW.content,
    content_hash: RAW.content_hash,
  };
  const topicsInput = { articleId: ARTICLE.id, assignments: [] };

  assert.equal(await service.startSearchRun({ query: "science" }), RUN);
  assert.equal(await service.finishSearchRun(RUN.id, { resultCount: 1 }), COMPLETED_RUN);
  assert.equal(await service.failSearchRun(RUN.id, failure), FAILED_RUN);
  assert.equal(await service.createOrResumeArticleCandidate(candidateInput), null);
  assert.equal(await service.saveRawContent(rawInput), RAW);
  assert.deepEqual(await service.replaceArticleTopics(topicsInput), []);
  assert.equal(await service.recordAiUsage(usageInput), USAGE);
  assert.equal((calls.at(-1) as unknown[])[1], usageInput);
  await assert.rejects(
    service.transitionArticle(ARTICLE.id, "discovered", "extracted"),
    (error) => error === failure,
  );
});

test("research application composition binds all four outbound Symbol gateways explicitly", async () => {
  const signal = new AbortController().signal;
  const aiRequest = { operation: "curate", input: { count: 2 } };
  const searchRequest = { query: "science", windowHours: 48, limit: 8 };
  const fetchRequest = { url: ARTICLE.canonical_url, kind: "article" as const };
  const ai: ResearchAiGateway = {
    async generate(request, receivedSignal) {
      assert.equal(request, aiRequest);
      assert.equal(receivedSignal, signal);
      return { output: {}, usageEvents: [] };
    },
  };
  const search: ResearchSearchGateway = {
    async search(request, receivedSignal) {
      assert.equal(request, searchRequest);
      assert.equal(receivedSignal, signal);
      return { items: [], usageEvents: [] };
    },
  };
  const fetch: ResearchFetchGateway = {
    async fetch(request, receivedSignal) {
      assert.equal(request, fetchRequest);
      assert.equal(receivedSignal, signal);
      return {
        finalUrl: ARTICLE.canonical_url,
        content: "Evidence",
        contentType: "text",
        contentHash: "hash",
      };
    },
  };
  const execution: ResearchExecutionGateway = {
    async execute() { return { candidates: [], usageEvents: [], finish: {} }; },
  };
  await ai.generate(aiRequest, signal);
  await search.search(searchRequest, signal);
  await fetch.fetch(fetchRequest, signal);

  const module = ResearchApplicationModule.register({ ai, search, fetch, execution });
  assert.deepEqual(module.imports, [
    CatalogPersistenceModule,
    ResearchPersistenceModule,
    UsagePersistenceModule,
  ]);
  const providers = module.providers as Array<{ provide?: symbol; useValue?: unknown } | Function>;
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
  assert.deepEqual(module.exports, [
    RESEARCH_AI_GATEWAY,
    RESEARCH_SEARCH_GATEWAY,
    RESEARCH_FETCH_GATEWAY,
    RESEARCH_EXECUTION_GATEWAY,
    RunResearchUseCase,
    ResearchService,
  ]);

  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, RunResearchUseCase),
    [
      { index: 3, param: RESEARCH_EXECUTION_GATEWAY },
      { index: 2, param: USAGE_REPORTING_PERSISTENCE },
      { index: 1, param: CATALOG_PERSISTENCE },
      { index: 0, param: RESEARCH_INGESTION_PERSISTENCE },
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
