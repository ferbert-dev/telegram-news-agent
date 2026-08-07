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
          : { output_parsed: { status: "OK" } };
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
    query: "AI news",
    windowHours: 48,
    allowedDomains: ["example.com"],
  });

  assert.equal(generated.value.status, "OK");
  assert.equal(discovered.items.length, 1);
  assert.equal(calls[0].store, false);
  assert.deepEqual(calls[0].reasoning, { effort: "medium" });
  assert.deepEqual(calls[1].tools, [
    {
      type: "web_search",
      filters: { allowed_domains: ["example.com"] },
    },
  ]);
  assert.equal(calls[1].tool_choice, "required");
  assert.deepEqual(calls[1].include, ["web_search_call.action.sources"]);
  assert.deepEqual(calls[1].reasoning, { effort: "medium" });
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
    query: "AI news",
    windowHours: 48,
    allowedDomains: ["example.com"],
  });

  assert.equal(generated.value.status, "OK");
  assert.equal(discovered.items.length, 1);
  assert.equal(calls[0].config.responseMimeType, "application/json");
  assert.deepEqual(calls[1].config.tools, [{ googleSearch: {} }]);
  assert.equal(calls[1].config.responseMimeType, undefined);
});
