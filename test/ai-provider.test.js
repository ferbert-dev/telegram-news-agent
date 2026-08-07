import assert from "node:assert/strict";
import test from "node:test";
import {
  AiProvidersExhaustedError,
  createAiProvider,
  createFallbackAiProvider,
  getAiProviderOrder,
} from "../src/ai-provider.js";

test("provider order defaults to OpenAI then Gemini and rejects unknown providers", () => {
  assert.deepEqual(getAiProviderOrder({}), ["openai", "gemini"]);
  assert.deepEqual(
    getAiProviderOrder({ AI_PROVIDER_ORDER: "gemini, openai, gemini" }),
    ["gemini", "openai"],
  );
  assert.throws(
    () => getAiProviderOrder({ AI_PROVIDER_ORDER: "gemini,unknown" }),
    /Unsupported AI provider/,
  );
});

test("missing OpenAI key is skipped while configured Gemini remains available", () => {
  const provider = createAiProvider({
    AI_PROVIDER_ORDER: "openai,gemini",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-2.5-flash",
  });
  assert.deepEqual(provider.names, ["gemini"]);
});

test("fallback tries the next provider and logs only a safe error code", async () => {
  const warnings = [];
  const provider = createFallbackAiProvider(
    [
      {
        name: "openai",
        async generateStructured() {
          const error = new Error("sensitive upstream detail secret-value");
          error.status = 429;
          throw error;
        },
      },
      {
        name: "gemini",
        async generateStructured() {
          return {
            value: { ok: true },
            provider: "gemini",
            model: "gemini-2.5-flash",
          };
        },
      },
    ],
    { log: { warn: (message) => warnings.push(message) } },
  );

  const result = await provider.generateStructured({});
  assert.equal(result.provider, "gemini");
  assert.match(warnings[0], /rate_limited/);
  assert.doesNotMatch(warnings[0], /sensitive|secret-value/);
});

test("fallback reports a stable error after every provider fails", async () => {
  const provider = createFallbackAiProvider(
    [
      {
        name: "openai",
        async searchNews() {
          throw new Error("failed");
        },
      },
      {
        name: "gemini",
        async searchNews() {
          throw new Error("failed");
        },
      },
    ],
    { log: { warn() {} } },
  );

  await assert.rejects(
    provider.searchNews({}),
    (error) =>
      error instanceof AiProvidersExhaustedError &&
      error.code === "ai_providers_exhausted",
  );
});

test("feed-source search uses the same OpenAI to Gemini fallback order", async () => {
  const calls = [];
  const provider = createFallbackAiProvider(
    [
      {
        name: "openai",
        async searchFeeds() {
          calls.push("openai");
          throw Object.assign(new Error("rate limit"), { status: 429 });
        },
      },
      {
        name: "gemini",
        async searchFeeds() {
          calls.push("gemini");
          return { provider: "gemini", model: "flash", items: [] };
        },
      },
    ],
    { log: { warn() {} } },
  );

  assert.equal((await provider.searchFeeds({})).provider, "gemini");
  assert.deepEqual(calls, ["openai", "gemini"]);
});
