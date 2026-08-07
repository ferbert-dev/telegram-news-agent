import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDraftEvidence,
  runPipeline,
  startPipelineLeaseHeartbeat,
} from "../src/pipeline.js";

test("unverified Reddit trends allow only the linked page and discussion URL", () => {
  const evidence = buildDraftEvidence({
    canonicalUrl: "https://example.com/rumor",
    discoveryUrl: "https://www.reddit.com/r/test/comments/rumor/",
    title: "Rumored release",
    publishedAt: "2026-06-29T00:00:00Z",
    evidenceText: "A community member described a possible release.",
    unverified: true,
    source: { name: "Reddit Test", is_primary: false },
  });

  assert.deepEqual(
    evidence.map((item) => item.url),
    [
      "https://example.com/rumor",
      "https://www.reddit.com/r/test/comments/rumor/",
    ],
  );
  assert.ok(evidence.every((item) => item.primary === false));
  assert.ok(
    evidence.every(
      (item) => item.verificationStatus === "unverified_community",
    ),
  );
});

test("web-search evidence keeps the direct publisher and verification tier", () => {
  const evidence = buildDraftEvidence({
    canonicalUrl: "https://news.example.net/ai-report",
    title: "Independent report",
    publishedAt: "2026-06-29T00:00:00Z",
    evidenceText: "Extracted direct article text.",
    publisher: "news.example.net",
    verificationStatus: "web_source",
    source: { name: "news.example.net", is_primary: false },
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].publisher, "news.example.net");
  assert.equal(evidence[0].primary, false);
  assert.equal(evidence[0].verificationStatus, "web_source");
});

function repositoryFixture({ leaseAcquired = true } = {}) {
  const calls = [];
  return {
    calls,
    async acquirePipelineLease(...args) {
      calls.push(["acquire", ...args]);
      return leaseAcquired;
    },
    async renewPipelineLease(...args) {
      calls.push(["renew", ...args]);
      return true;
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
    async createReviewDraft(draft) {
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

test("lease heartbeat renews with owner fencing and stops cleanly", async () => {
  let tick;
  let cleared = false;
  const calls = [];
  const heartbeat = startPipelineLeaseHeartbeat({
    repository: {
      async renewPipelineLease(...args) {
        calls.push(args);
        return true;
      },
    },
    leaseName: "daily",
    ownerId: "00000000-0000-4000-8000-000000000001",
    leaseTtlSeconds: 30,
    setIntervalImpl(callback, interval) {
      tick = callback;
      assert.equal(interval, 10_000);
      return { unref() {} };
    },
    clearIntervalImpl() {
      cleared = true;
    },
  });

  await tick();
  heartbeat.assertOwned();
  await heartbeat.stop();
  assert.equal(cleared, true);
  assert.deepEqual(calls, [
    ["daily", "00000000-0000-4000-8000-000000000001", 30],
  ]);
});

test("lease heartbeat fences work after ownership expires or changes", async () => {
  let tick;
  const heartbeat = startPipelineLeaseHeartbeat({
    repository: {
      async renewPipelineLease() {
        return false;
      },
    },
    leaseName: "daily",
    ownerId: "00000000-0000-4000-8000-000000000001",
    leaseTtlSeconds: 30,
    setIntervalImpl(callback) {
      tick = callback;
      return 1;
    },
    clearIntervalImpl() {},
  });

  await tick();
  assert.throws(() => heartbeat.assertOwned(), /ownership was lost/);
  await assert.rejects(heartbeat.stop(), /ownership was lost/);
});

test("expired owner is fenced after another run acquires the lease", async () => {
  let owner = "owner-1";
  let expiresAt = 10;
  let clock = 0;
  const repository = {
    async acquirePipelineLease(_name, candidate, ttl) {
      if (expiresAt > clock && owner !== candidate) return false;
      owner = candidate;
      expiresAt = clock + ttl;
      return true;
    },
    async renewPipelineLease(_name, candidate, ttl) {
      if (owner !== candidate || expiresAt <= clock) return false;
      expiresAt = clock + ttl;
      return true;
    },
  };
  let firstTick;
  const first = startPipelineLeaseHeartbeat({
    repository,
    leaseName: "daily",
    ownerId: "owner-1",
    leaseTtlSeconds: 10,
    setIntervalImpl(callback) {
      firstTick = callback;
      return 1;
    },
    clearIntervalImpl() {},
  });

  clock = 11;
  assert.equal(
    await repository.acquirePipelineLease("daily", "owner-2", 10),
    true,
  );
  await firstTick();
  assert.throws(() => first.assertOwned(), /ownership was lost/);
  assert.equal(
    await repository.acquirePipelineLease("daily", "owner-3", 10),
    false,
  );
});
