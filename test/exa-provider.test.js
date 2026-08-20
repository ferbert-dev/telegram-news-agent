import assert from "node:assert/strict";
import test from "node:test";
import {
  createExaProvider,
  ExaDailySearchCapError,
  getExaProviderConfig,
} from "../src/exa-provider.js";

function config(overrides = {}) {
  return {
    apiKey: "test-key",
    searchType: "auto",
    model: "exa-search:auto",
    dailySearchCap: 2,
    maxResults: 8,
    ...overrides,
  };
}

test("Exa stays disabled unless both the flag and API key are present", () => {
  assert.equal(getExaProviderConfig({ EXA_API_KEY: "key" }), null);
  assert.equal(getExaProviderConfig({ EXA_ENABLED: "true" }), null);
  assert.deepEqual(
    getExaProviderConfig({
      EXA_ENABLED: "true",
      EXA_API_KEY: " key ",
      EXA_SEARCH_TYPE: "fast",
      EXA_DAILY_SEARCH_CAP: "12",
      EXA_MAX_RESULTS: "6",
    }),
    {
      apiKey: "key",
      searchType: "fast",
      model: "exa-search:fast",
      dailySearchCap: 12,
      maxResults: 6,
    },
  );
});

test("Exa news search is bounded and normalizes source content", async () => {
  let request;
  const provider = createExaProvider(config(), {
    now: () => new Date("2026-08-20T12:00:00.000Z"),
    capStore: new Map(),
    client: {
      async search(query, options) {
        request = { query, options };
        return {
          requestId: "exa-request-1",
          results: [
            {
              title: "Ocean discovery",
              url: "https://example.com/ocean#section",
              author: "Reporter",
              publishedDate: "2026-08-20T09:00:00Z",
              highlights: ["Scientists documented a new deep-sea habitat."],
              unsupported: "discarded",
            },
            { title: "Missing content", url: "https://example.com/empty" },
          ],
        };
      },
    },
  });

  const result = await provider.searchNews({
    query: "ocean news",
    topicCodes: ["nature"],
    customTopics: ["marine biology"],
    windowHours: 24,
    limit: 5,
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://example.com/ocean");
  assert.equal(result.provider, "exa");
  assert.equal(result.usageEvents[0].providerResponseId, "exa-request-1");
  assert.equal(result.usageEvents[0].webSearchCalls, 1);
  assert.equal(result.usageEvents[0].inputTokens, 0);
  assert.equal(request.options.category, "news");
  assert.equal(request.options.numResults, 5);
  assert.equal(request.options.startPublishedDate, "2026-08-19T12:00:00.000Z");
  assert.equal(request.options.contents.text.maxCharacters, 2_000);
  assert.match(request.query, /marine biology/);
});

test("Exa feed search keeps only eight direct RSS or Atom-looking URLs", async () => {
  let options;
  const provider = createExaProvider(config({ maxResults: 10 }), {
    capStore: new Map(),
    client: {
      async search(_query, requestOptions) {
        options = requestOptions;
        return {
          results: [
            ...Array.from({ length: 10 }, (_, index) => ({
              title: `Publisher feed ${index + 1}`,
              url: `https://example.com/feed-${index + 1}.xml`,
            })),
            { title: "Publisher home", url: "https://example.com/" },
          ],
        };
      },
    },
  });

  const result = await provider.searchFeeds({ topicCodes: ["science"] });
  assert.equal(result.items.length, 8);
  assert.deepEqual(result.items[0], {
    name: "Publisher feed 1",
    feedUrl: "https://example.com/feed-1.xml",
    homepageUrl: "https://example.com",
  });
  assert.equal(options.numResults, 8);
  assert.equal(result.usageEvents[0].operation, "feed_source_search");
});

test("Exa daily cap is shared by provider instances in one process", async () => {
  let calls = 0;
  const sharedConfig = config({
    apiKey: "process-cap-test-key",
    dailySearchCap: 1,
  });
  const client = {
    async search() {
      calls += 1;
      return { results: [] };
    },
  };
  const firstProvider = createExaProvider(sharedConfig, { client });
  const secondProvider = createExaProvider(sharedConfig, { client });

  await firstProvider.searchNews({ query: "first" });
  await assert.rejects(
    secondProvider.searchNews({ query: "second" }),
    (error) =>
      error instanceof ExaDailySearchCapError &&
      error.code === "exa_daily_search_cap" &&
      error.status === 429,
  );
  assert.equal(calls, 1);
});
