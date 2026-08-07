import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createGeminiProvider } from "../src/gemini-provider.js";
import { createOpenAiProvider } from "../src/openai-provider.js";

const Status = z.object({ status: z.literal("OK") });
const STATUS_JSON_SCHEMA = {
  type: "object",
  properties: { status: { type: "string", enum: ["OK"] } },
  required: ["status"],
};

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
    { apiKey: "test-key", model: "gpt-5.6" },
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
  assert.deepEqual(calls[1].tools, [{ type: "web_search" }]);
  assert.deepEqual(calls[1].include, ["web_search_call.action.sources"]);
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
