import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySourceFetchError,
  discoverNewFeedSources,
  sourceDiscoveryKey,
} from "../src/source-maintenance.js";

test("source discovery keys are stable across ordering and output languages", () => {
  const left = sourceDiscoveryKey({
    topicCodes: ["nature", "science"],
    customTopics: ["Ocean", "Wildlife"],
    languageCode: "de",
  });
  const right = sourceDiscoveryKey({
    topicCodes: ["SCIENCE", "nature"],
    customTopics: ["wildlife", "ocean"],
    languageCode: "uk",
  });

  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
});

test("source failures are reduced to safe health codes", () => {
  assert.equal(
    classifySourceFetchError(new Error("Feed request failed with HTTP 403")),
    "http_403",
  );
  assert.equal(
    classifySourceFetchError(
      new Error("Unsupported feed: expected RSS 2.0 or Atom"),
    ),
    "invalid_feed",
  );
  assert.equal(
    classifySourceFetchError(new Error("API key=secret should never persist")),
    "fetch_failed",
  );
});

test("feed discovery validates live XML before saving a PostgreSQL source", async () => {
  const calls = [];
  const repository = {
    async claimSourceDiscovery(topicKey) {
      calls.push(["claim", topicKey]);
      return true;
    },
    async upsertDiscoveredSource(source) {
      calls.push(["upsert", source]);
      return {
        id: "source-new",
        name: source.name,
        homepage_url: source.homepageUrl,
        feed_url: source.feedUrl,
        source_type: "rss",
        reliability_score: source.reliabilityScore,
        is_primary: false,
      };
    },
    async completeSourceDiscovery(result) {
      calls.push(["complete", result]);
      return true;
    },
  };
  const entry = {
    title: "Ocean discovery",
    canonicalUrl: "https://publisher.example/article",
    publishedAt: "2026-08-07T08:00:00.000Z",
    summary: "Researchers documented a new result.",
    contentHash: "hash",
  };
  const result = await discoverNewFeedSources({
    repository,
    aiProvider: {
      async searchFeeds() {
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          usageEvents: [],
          items: [
            {
              name: "Publisher Science",
              feedUrl: "https://publisher.example/feed.xml?utm_source=search",
              homepageUrl: "https://publisher.example/science",
            },
            {
              name: "Unsafe",
              feedUrl: "http://127.0.0.1/feed.xml",
              homepageUrl: null,
            },
          ],
        };
      },
    },
    newsSettings: {
      channelId: "@channel",
      languageCode: "de",
      topicCodes: ["science", "nature"],
      customTopics: ["Ocean exploration"],
    },
    fetchFeedImpl: async (url) => {
      assert.equal(
        url,
        "https://publisher.example/feed.xml?utm_source=search",
      );
      return [entry];
    },
    retryImpl: (operation) => operation(),
    searchRunId: "run-1",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.sources.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].error_code, "unsafe_url");
  const upsert = calls.find(([kind]) => kind === "upsert")[1];
  assert.equal(upsert.discoveredBy, "openai");
  assert.deepEqual(upsert.topicCodes, ["science", "nature"]);
  assert.deepEqual(upsert.discoveryMetadata.custom_topics, [
    "Ocean exploration",
  ]);
  assert.equal(
    calls.find(([kind]) => kind === "complete")[1].resultCount,
    1,
  );
});

test("feed source cooldown prevents a repeated paid provider search", async () => {
  let searchCalls = 0;
  const result = await discoverNewFeedSources({
    repository: {
      async claimSourceDiscovery() {
        return false;
      },
      async completeSourceDiscovery() {},
      async upsertDiscoveredSource() {},
    },
    aiProvider: {
      async searchFeeds() {
        searchCalls += 1;
      },
    },
    newsSettings: { topicCodes: ["history"], customTopics: [] },
    fetchFeedImpl: async () => [],
    retryImpl: (operation) => operation(),
    searchRunId: "run-2",
  });

  assert.equal(result.status, "cooldown");
  assert.equal(searchCalls, 0);
});
