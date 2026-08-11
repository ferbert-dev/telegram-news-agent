import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createGeminiProvider } from "../src/gemini-provider.js";
import {
  createOpenAiProvider,
  getOpenAiConfig,
} from "../src/openai-provider.js";

const Status = z.object({ status: z.literal("OK") });
const STATUS_JSON_SCHEMA = {
  type: "object",
  properties: { status: { type: "string", enum: ["OK"] } },
  required: ["status"],
};

test("news discovery rejects malformed article URLs after parsing", async () => {
  const { NewsDiscovery } = await import("../src/ai-news-discovery.js");
  assert.throws(
    () =>
      NewsDiscovery.parse({
        items: [
          { title: "Invalid", url: "not-a-url", summary: "Invalid URL." },
        ],
      }),
    /Invalid article URL/,
  );
});

test("feed discovery rejects malformed feed URLs after parsing", async () => {
  const { FeedDiscovery } = await import("../src/ai-feed-discovery.js");
  assert.throws(
    () =>
      FeedDiscovery.parse({
        items: [
          { name: "Invalid", feedUrl: "not-a-url", homepageUrl: null },
        ],
      }),
    /Invalid HTTP URL/,
  );
});

test("OpenAI config defaults to GPT-5.4 with medium reasoning", () => {
  assert.deepEqual(getOpenAiConfig({ OPENAI_API_KEY: "test-key" }), {
    apiKey: "test-key",
    model: "gpt-5.4-2026-03-05",
    reasoningEffort: "medium",
  });
});

test("OpenAI config rejects an unsupported reasoning effort", () => {
  assert.throws(
    () =>
      getOpenAiConfig({
        OPENAI_API_KEY: "test-key",
        OPENAI_REASONING_EFFORT: "maximum",
      }),
    /OPENAI_REASONING_EFFORT/,
  );
});

test("OpenAI adapter uses Responses structured output and web search", async () => {
  const calls = [];
  const client = {
    responses: {
      async parse(request) {
        calls.push(request);
        return request.tools
          ? {
              id: "resp_search",
              output: [{ type: "web_search_call" }],
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 10 },
                output_tokens: 20,
                output_tokens_details: { reasoning_tokens: 5 },
              },
              output_parsed: {
                items: [
                  {
                    title: "Official release",
                    url: "https://example.com/release",
                    summary: "An official release summary.",
                  },
                ],
              },
            }
          : {
              id: "resp_draft",
              usage: {
                input_tokens: 50,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 10,
                output_tokens_details: { reasoning_tokens: 2 },
              },
              output_parsed: { status: "OK" },
            };
      },
    },
  };
  const provider = createOpenAiProvider(
    {
      apiKey: "test-key",
      model: "gpt-5.4-2026-03-05",
      reasoningEffort: "medium",
    },
    { client },
  );

  const generated = await provider.generateStructured({
    systemInstruction: "Return status.",
    input: { status: "OK" },
    zodSchema: Status,
    schemaName: "status",
  });
  const discovered = await provider.searchNews({
    query: "Nature and animal news",
    windowHours: 48,
    languageCode: "de",
    topicCodes: ["nature", "animals"],
    customTopics: ["Meeresbiologie"],
  });

  assert.equal(generated.value.status, "OK");
  assert.equal(discovered.items.length, 1);
  assert.equal(generated.usageEvents[0].inputTokens, 50);
  assert.equal(discovered.usageEvents[0].webSearchCalls, 1);
  assert.equal(discovered.usageEvents[0].estimatedCostUsd, 0.0105275);
  assert.equal(calls[0].store, false);
  assert.deepEqual(calls[0].reasoning, { effort: "medium" });
  assert.deepEqual(calls[1].tools, [
    {
      type: "web_search",
      search_context_size: "low",
      external_web_access: true,
    },
  ]);
  assert.equal(calls[1].tool_choice, "required");
  assert.deepEqual(calls[1].include, ["web_search_call.action.sources"]);
  assert.deepEqual(calls[1].reasoning, { effort: "medium" });
  assert.equal(calls[1].max_tool_calls, 1);
  assert.doesNotMatch(calls[1].input[0].content, /recent AI news/);
  assert.match(calls[1].input[0].content, /subject labels only/);
  assert.match(calls[1].input[0].content, /German/);
  assert.deepEqual(JSON.parse(calls[1].input[1].content).topicCodes, [
    "nature",
    "animals",
  ]);
});

test("Gemini adapter uses structured JSON generation and Google Search", async () => {
  const calls = [];
  const client = {
    models: {
      async generateContent(request) {
        calls.push(request);
        return request.config.tools
          ? {
              text: JSON.stringify({
                items: [
                  {
                    title: "Official release",
                    url: "https://example.com/release",
                    summary: "An official release summary.",
                  },
                ],
              }),
            }
          : { text: JSON.stringify({ status: "OK" }) };
      },
    },
  };
  const provider = createGeminiProvider(
    { apiKey: "test-key", model: "gemini-2.5-flash" },
    { client },
  );

  const generated = await provider.generateStructured({
    systemInstruction: "Return status.",
    input: { status: "OK" },
    zodSchema: Status,
    jsonSchema: STATUS_JSON_SCHEMA,
  });
  const discovered = await provider.searchNews({
    query: "Nature and animal news",
    windowHours: 48,
    languageCode: "uk",
    topicCodes: ["nature", "animals"],
    customTopics: ["Морська біологія"],
  });

  assert.equal(generated.value.status, "OK");
  assert.equal(discovered.items.length, 1);
  assert.equal(calls[0].config.responseMimeType, "application/json");
  assert.deepEqual(calls[1].config.tools, [{ googleSearch: {} }]);
  assert.equal(calls[1].config.responseMimeType, undefined);
  assert.doesNotMatch(calls[1].config.systemInstruction, /recent AI news/);
  assert.match(calls[1].config.systemInstruction, /subject labels only/);
  assert.match(calls[1].config.systemInstruction, /Ukrainian/);
  assert.deepEqual(JSON.parse(calls[1].contents).customTopics, [
    "Морська біологія",
  ]);
});

test("OpenAI feed maintenance searches once for RSS endpoints, not articles", async () => {
  let request;
  const provider = createOpenAiProvider(
    {
      apiKey: "test-key",
      model: "gpt-5.4-2026-03-05",
      reasoningEffort: "medium",
    },
    {
      client: {
        responses: {
          async parse(input) {
            request = input;
            return {
              id: "resp_feed_search",
              output: [{ type: "web_search_call" }],
              usage: { input_tokens: 80, output_tokens: 20 },
              output_parsed: {
                items: [
                  {
                    name: "Publisher",
                    feedUrl: "https://example.com/feed.xml",
                    homepageUrl: "https://example.com/",
                  },
                ],
              },
            };
          },
        },
      },
    },
  );

  const result = await provider.searchFeeds({
    topicCodes: ["science"],
    customTopics: ["Ocean exploration"],
    languageCode: "de",
  });

  assert.equal(result.items[0].feedUrl, "https://example.com/feed.xml");
  assert.equal(result.usageEvents[0].operation, "feed_source_search");
  assert.equal(request.max_tool_calls, 1);
  assert.equal(request.tools[0].search_context_size, "low");
  assert.match(request.input[0].content, /source maintenance, not article search/i);
  assert.doesNotMatch(request.input[0].content, /direct article URLs/i);
});

test("Gemini feed maintenance uses Google Search and validates the result", async () => {
  let request;
  const provider = createGeminiProvider(
    { apiKey: "test-key", model: "gemini-2.5-flash" },
    {
      client: {
        models: {
          async generateContent(input) {
            request = input;
            return {
              text: JSON.stringify({
                items: [
                  {
                    name: "Publisher",
                    feedUrl: "https://example.com/feed.xml",
                    homepageUrl: "https://example.com/",
                  },
                ],
              }),
            };
          },
        },
      },
    },
  );

  const result = await provider.searchFeeds({ topicCodes: ["history"] });

  assert.equal(result.items.length, 1);
  assert.deepEqual(request.config.tools, [{ googleSearch: {} }]);
  assert.match(request.config.systemInstruction, /source maintenance, not article search/i);
});

test("OpenAI editorial fact search is one bounded tool call with its own usage operation", async () => {
  let request;
  const provider = createOpenAiProvider(
    {
      apiKey: "test-key",
      model: "configured-openai-model",
      reasoningEffort: "high",
    },
    {
      client: {
        responses: {
          async parse(input) {
            request = input;
            return {
              id: "resp_editorial_fact",
              output: [
                {
                  type: "web_search_call",
                  action: {
                    sources: [
                      { url: "https://agency.example.gov/decision" },
                    ],
                  },
                },
              ],
              usage: { input_tokens: 40, output_tokens: 12 },
              output_parsed: {
                fact: {
                  claim: "The agency approved the system.",
                  sourceUrl: "https://agency.example.gov/decision",
                  sourceTitle: "Agency decision",
                  sourceKind: "government",
                  evidenceText: "The agency approved the system.",
                },
              },
            };
          },
        },
      },
    },
  );

  const result = await provider.searchFact({
    query: "agency system approval",
    expectedClaim: "The agency approved the system.",
    languageCode: "de",
  });

  assert.equal(result.fact.sourceKind, "government");
  assert.equal(result.model, "configured-openai-model");
  assert.equal(result.usageEvents[0].operation, "editorial_fact_search");
  assert.equal(result.usageEvents[0].webSearchCalls, 1);
  assert.equal(request.max_tool_calls, 1);
  assert.equal(request.tool_choice, "required");
  assert.deepEqual(request.tools, [
    { type: "web_search", search_context_size: "low" },
  ]);
  assert.deepEqual(request.include, ["web_search_call.action.sources"]);
  assert.match(request.input[0].content, /Search once/);
  assert.match(request.input[0].content, /German/);
});

test("Gemini editorial fact search uses one grounded request and validates evidence", async () => {
  let request;
  const provider = createGeminiProvider(
    { apiKey: "test-key", model: "configured-gemini-model" },
    {
      client: {
        models: {
          async generateContent(input) {
            request = input;
            return {
              text: JSON.stringify({
                fact: {
                  claim: "The university published the result.",
                  sourceUrl: "https://university.example.edu/result",
                  sourceTitle: "University result",
                  sourceKind: "academic",
                  evidenceText: "The university published the result.",
                },
              }),
              usageMetadata: {
                promptTokenCount: 30,
                candidatesTokenCount: 8,
              },
              candidates: [
                {
                  groundingMetadata: {
                    webSearchQueries: ["one query"],
                    groundingChunks: [
                      {
                        web: {
                          uri: "https://university.example.edu/result",
                        },
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      },
    },
  );

  const result = await provider.searchFact({
    query: "university result publication",
    expectedClaim: "The university published the result.",
    languageCode: "uk",
  });

  assert.equal(result.fact.sourceKind, "academic");
  assert.equal(result.model, "configured-gemini-model");
  assert.equal(result.usageEvents[0].operation, "editorial_fact_search");
  assert.equal(result.usageEvents[0].webSearchCalls, 1);
  assert.deepEqual(request.config.tools, [{ googleSearch: {} }]);
  assert.match(request.config.systemInstruction, /Search once/);
  assert.match(request.config.systemInstruction, /Ukrainian/);
});
