import assert from "node:assert/strict";

const { CatalogService } = await import(
  "../dist/catalog/application/catalog.service.js"
);
const { CatalogApplicationModule } = await import(
  "../dist/catalog/catalog-application.module.js"
);
const { ResearchService } = await import(
  "../dist/research/application/research.service.js"
);
const { RunResearchUseCase } = await import(
  "../dist/research/application/run-research.use-case.js"
);
const { LegacyResearchExecutionGateway } = await import(
  "../dist/research/legacy-research-execution.gateway.js"
);
const { LegacyResearchExecutionGatewayModule } = await import(
  "../dist/research/legacy-research-execution.module.js"
);
const { ResearchApplicationModule } = await import(
  "../dist/research/research-application.module.js"
);
const tokens = await import("../dist/research/research-gateway.tokens.js");
const sourceAcquisition = await import("../dist/research/source-acquisition.module.js");

const source = {
  id: "source-1",
  name: "Example",
  homepage_url: null,
  feed_url: "https://example.test/feed.xml",
  source_type: "rss",
  reliability_score: 80,
  enabled: true,
  last_checked_at: null,
  created_at: "2026-08-09T08:00:00.000Z",
  updated_at: "2026-08-09T08:00:00.000Z",
  is_primary: true,
  last_success_at: null,
  last_failed_at: null,
  consecutive_failures: 0,
  last_error_code: null,
  disabled_until: null,
  discovered_by: "seed",
  discovery_metadata: {},
};
const catalog = new CatalogService({
  async listEnabledSources() { return [{ ...source, topic_codes: ["science"] }]; },
});
assert.equal((await catalog.listEnabledSources())[0].id, source.id);

const run = {
  id: "run-1",
  query: "science",
  status: "running",
  source_id: null,
  started_at: "2026-08-09T08:00:00.000Z",
  finished_at: null,
  result_count: 0,
  error: null,
  metadata: {},
};
const persistence = {
  async startSearchRun() { return run; },
  async finishSearchRun(_id, input) {
    assert.equal(input.resultCount, 0);
    return { ...run, status: "completed", result_count: 0 };
  },
  async failSearchRun() { throw new Error("must not fail"); },
};
const usage = {
  async recordAiUsage() { throw new Error("no usage expected"); },
};
const candidate = {
  article: {
    id: "article-1",
    source_id: source.id,
    search_run_id: run.id,
    canonical_url: "https://example.test/story",
    title: "Story",
    author: null,
    published_at: null,
    discovered_at: run.started_at,
    content_hash: "hash",
    status: "discovered",
    metadata: {},
    created_at: run.started_at,
    updated_at: run.started_at,
  },
  source,
  canonicalUrl: "https://example.test/story",
  title: "Story",
  summary: "Summary",
  author: null,
  publishedAt: null,
  contentHash: "hash",
  score: 100,
};
const executionResult = {
  runId: run.id,
  selected: candidate,
  candidates: [candidate],
  feedErrors: [],
  extractionErrors: [],
};
const execution = {
  async execute(_request, signal) {
    assert.equal(signal, abort.signal);
    return executionResult;
  },
};
const abort = new AbortController();
const useCase = new RunResearchUseCase(execution);
const service = new ResearchService(persistence, usage, useCase);
const result = await service.runResearch({ query: "science" }, abort.signal);
assert.equal(result, executionResult);

let adapterCalled = false;
const adapter = new LegacyResearchExecutionGateway(
  {
    async listEnabledSources() { return []; },
  },
  persistence,
  {
    async listRecentPublishedStories() { return []; },
  },
  usage,
  {
    discoveryProvider: {},
    async runResearchImpl(input) {
      adapterCalled = true;
      assert.equal(input.query, "science");
      return executionResult;
    },
  },
);
assert.equal(
  await adapter.execute({ input: { query: "science" } }),
  executionResult,
);
assert.equal(adapterCalled, true);
assert.equal(
  LegacyResearchExecutionGatewayModule.register({ discoveryProvider: {} })
    .exports.includes(tokens.RESEARCH_EXECUTION_GATEWAY),
  true,
);

const module = ResearchApplicationModule.register({
  ai: {},
  search: {},
  fetch: {},
  execution,
});
assert.equal(module.module, ResearchApplicationModule);
assert.equal(module.exports.includes(tokens.RESEARCH_EXECUTION_GATEWAY), true);
assert.equal(typeof CatalogApplicationModule, "function");
assert.equal(sourceAcquisition.SourceAcquisitionModule.register(null).exports.length, 1);
