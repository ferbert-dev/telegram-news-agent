import test from "node:test";
import assert from "node:assert/strict";
import {
  matchPrimarySource,
  rankCandidates,
  runResearch,
  scoreCandidate,
} from "../src/research.js";

const NOW = new Date("2026-06-27T00:00:00Z");
const PRIMARY_SOURCE = {
  id: "source-1",
  feed_url: "https://example.com/feed",
  source_type: "rss",
  is_primary: true,
  reliability_score: 90,
};

function candidate(overrides = {}) {
  return {
    title: "New AI agent released",
    canonicalUrl: "https://example.com/agent",
    author: "Research Team",
    publishedAt: "2026-06-26T18:00:00Z",
    summary: "A new agent model for research.",
    contentHash: "hash",
    source: PRIMARY_SOURCE,
    ...overrides,
  };
}

test("scoreCandidate rewards primary, recent, reliable, relevant sources", () => {
  const high = scoreCandidate(candidate(), PRIMARY_SOURCE, {
    now: NOW,
    keywords: ["agent", "research"],
  });
  const low = scoreCandidate(
    candidate({ publishedAt: "2026-06-24T00:00:00Z" }),
    { ...PRIMARY_SOURCE, is_primary: false, reliability_score: 40 },
    { now: NOW, keywords: ["unmatched"] },
  );

  assert.ok(high > low);
});

test("rankCandidates removes old and duplicate candidates deterministically", () => {
  const ranked = rankCandidates(
    [
      candidate(),
      candidate({ title: "Duplicate", source: { ...PRIMARY_SOURCE, reliability_score: 60 } }),
      candidate({
        canonicalUrl: "https://example.com/old",
        publishedAt: "2026-06-20T00:00:00Z",
      }),
    ],
    { now: NOW, windowHours: 48, keywords: ["agent"] },
  );

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].title, "New AI agent released");
});

test("Reddit discoveries can only map to configured primary domains", () => {
  const sources = [
    {
      ...PRIMARY_SOURCE,
      homepage_url: "https://openai.com/",
    },
  ];

  assert.equal(
    matchPrimarySource("https://openai.com/news/release", sources)?.id,
    PRIMARY_SOURCE.id,
  );
  assert.equal(
    matchPrimarySource("https://fake-openai.example/news", sources),
    undefined,
  );
});

test("runResearch persists candidates and completes the run", async () => {
  const calls = [];
  const repository = {
    async startSearchRun() {
      calls.push("start");
      return { id: "run-1" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {
      calls.push("checked");
    },
    async createOrResumeArticleCandidate(article) {
      calls.push(["article", article.canonical_url]);
      return { id: "article-1", ...article };
    },
    async saveRawContent(rawContent) {
      calls.push(["raw", rawContent.article_id]);
    },
    async finishSearchRun(id, details) {
      calls.push(["finish", id, details.resultCount]);
    },
    async failSearchRun() {
      calls.push("fail");
    },
  };
  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [candidate()],
    fetchArticleImpl: async () => ({
      text: "Extracted primary article evidence.",
      contentHash: "article-hash",
      finalUrl: "https://example.com/agent",
    }),
  });

  assert.equal(result.selected.article.id, "article-1");
  assert.deepEqual(calls, [
    "start",
    "checked",
    ["article", "https://example.com/agent"],
    ["raw", "article-1"],
    ["raw", "article-1"],
    ["finish", "run-1", 1],
  ]);
  assert.equal(result.selected.evidenceText, "Extracted primary article evidence.");
});

test("runResearch falls back to persisted primary RSS evidence when pages block extraction", async () => {
  let finished;
  const repository = {
    async startSearchRun() {
      return { id: "run-feed-fallback" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { id: "article-feed-fallback", ...article };
    },
    async saveRawContent() {},
    async finishSearchRun(_id, details) {
      finished = details;
    },
    async failSearchRun() {},
  };

  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [candidate()],
    fetchArticleImpl: async () => {
      throw new Error("Primary page request failed with HTTP 403");
    },
    retryImpl: (operation) => operation(),
  });

  assert.equal(result.selected.evidenceKind, "primary_feed_summary");
  assert.equal(result.selected.evidenceText, candidate().summary);
  assert.equal(result.extractionErrors.length, 1);
  assert.equal(
    finished.metadata.selected_evidence_kind,
    "primary_feed_summary",
  );
});

test("runResearch uses provider web search only when feeds have no recent candidates", async () => {
  const saved = [];
  let searchCalls = 0;
  const repository = {
    async startSearchRun() {
      return { id: "run-provider-search" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      saved.push(article);
      return { id: "article-provider-search", ...article };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };

  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [],
    discoveryProvider: {
      async searchNews() {
        searchCalls += 1;
        return {
          provider: "gemini",
          model: "gemini-2.5-flash",
          items: [
            {
              title: "Provider discovery",
              url: "https://example.com/provider-news",
              summary: "A verified official-source result.",
              publishedAt: "2026-06-26T20:00:00Z",
            },
            {
              title: "Unapproved domain",
              url: "https://aggregator.invalid/story",
              summary: "This must be rejected.",
              publishedAt: "2026-06-26T20:00:00Z",
            },
          ],
        };
      },
    },
    fetchArticleImpl: async () => {
      throw new Error("blocked");
    },
    retryImpl: (operation) => operation(),
  });

  assert.equal(searchCalls, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].metadata.discovery_kind, "gemini_web_search");
  assert.equal(result.selected.evidenceKind, "primary_feed_summary");
});

test("runResearch fails closed without primary sources", async () => {
  let failedMessage;
  const repository = {
    async startSearchRun() {
      return { id: "run-1" };
    },
    async listEnabledSources() {
      return [{ ...PRIMARY_SOURCE, is_primary: false }];
    },
    async failSearchRun(_id, error) {
      failedMessage = error.message;
    },
  };

  await assert.rejects(
    runResearch({ repository, query: "AI news", now: NOW }),
    /No enabled primary RSS sources/,
  );
  assert.equal(failedMessage, "No enabled primary RSS sources are configured");
});

test("runResearch does not reset or redraft an existing canonical URL", async () => {
  let extractionCalled = false;
  let failedMessage;
  const repository = {
    async startSearchRun() {
      return { id: "run-duplicate" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate() {
      return null;
    },
    async failSearchRun(_id, error) {
      failedMessage = error.message;
    },
  };

  await assert.rejects(
    runResearch({
      repository,
      query: "AI news",
      now: NOW,
      fetchFeedImpl: async () => [candidate()],
      fetchArticleImpl: async () => {
        extractionCalled = true;
      },
    }),
    /No new primary-source articles/,
  );
  assert.equal(extractionCalled, false);
  assert.equal(failedMessage, "No new primary-source articles were found");
});
