import assert from "node:assert/strict";
import test from "node:test";
import { runPipeline } from "../src/pipeline.js";

function repositoryFixture({ leaseAcquired = true } = {}) {
  const calls = [];
  return {
    calls,
    async acquirePipelineLease(...args) {
      calls.push(["acquire", ...args]);
      return leaseAcquired;
    },
    async releasePipelineLease(...args) {
      calls.push(["release", ...args]);
      return true;
    },
    async startSearchRun() {
      return { id: "run-1" };
    },
    async listEnabledSources() {
      return [
        {
          id: "source-1",
          name: "Primary",
          feed_url: "https://example.com/feed.xml",
          source_type: "rss",
          reliability_score: 95,
          is_primary: true,
        },
      ];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { ...article, id: "article-1" };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
    async transitionArticle(id, from, to) {
      calls.push(["article", id, from, to]);
    },
    async createDraft(draft) {
      return { ...draft, id: "draft-1" };
    },
  };
}

test("runPipeline researches and creates a review draft without publishing", async () => {
  const repository = repositoryFixture();
  const aiClient = {
    models: {
      async generateContent() {
        return {
          text: JSON.stringify({
            headline: "New model",
            telegramText:
              "New model\n\nVerified report.\n\nSource: https://example.com/news",
            claims: [
              {
                text: "A model was announced.",
                sourceUrl: "https://example.com/news",
              },
            ],
            sourceUrls: ["https://example.com/news"],
            caveat: "Only the publisher announcement is available.",
          }),
        };
      },
    },
  };

  const result = await runPipeline({
    repository,
    aiClient,
    model: "test-model",
    ownerId: "00000000-0000-4000-8000-000000000001",
    now: new Date("2026-06-27T12:00:00Z"),
    fetchFeedImpl: async () => [
      {
        title: "New model",
        canonicalUrl: "https://example.com/news",
        publishedAt: "2026-06-27T10:00:00Z",
        summary: "A model was announced.",
        author: "Primary",
        contentHash: "hash",
      },
    ],
    fetchArticleImpl: async () => ({
      text: "A model was announced with documented evaluation results and limitations from the primary source.",
      contentHash: "article-hash",
      finalUrl: "https://example.com/news",
    }),
  });

  assert.equal(result.draft.status, "review");
  assert.match(result.preview, /example\.com\/news/);
  assert.deepEqual(repository.calls.at(-1).slice(0, 2), [
    "release",
    "daily-news-pipeline",
  ]);
});

test("runPipeline refuses a concurrent run", async () => {
  const repository = repositoryFixture({ leaseAcquired: false });

  await assert.rejects(
    runPipeline({
      repository,
      aiClient: {},
      model: "test",
      ownerId: "00000000-0000-4000-8000-000000000001",
    }),
    /already running/,
  );
  assert.equal(repository.calls.some(([name]) => name === "release"), false);
});
