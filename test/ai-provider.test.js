import assert from "node:assert/strict";
import test from "node:test";
import {
  AiProvidersExhaustedError,
  createAiProvider,
  createFallbackAiProvider,
  getAiProviderOrder,
} from "../src/ai-provider.js";
import {
  classifySafeProviderError,
  isTransientProviderError,
} from "../src/ai-provider-attempts.js";

test("provider order defaults to OpenAI then Gemini and rejects unknown providers", () => {
  assert.deepEqual(getAiProviderOrder({}), ["openai", "gemini"]);
  assert.deepEqual(
    getAiProviderOrder({ EXA_ENABLED: "true", EXA_API_KEY: "exa-key" }),
    ["exa", "openai", "gemini"],
  );
  assert.deepEqual(
    getAiProviderOrder({ AI_PROVIDER_ORDER: "exa, gemini, openai, exa" }),
    ["exa", "gemini", "openai"],
  );
  assert.throws(
    () => getAiProviderOrder({ AI_PROVIDER_ORDER: "gemini,unknown" }),
    /Unsupported AI provider/,
  );
});

test("classifies provider quota codes as quota_exhausted and non-transient", () => {
  assert.equal(
    classifySafeProviderError({
      code: "insufficient_quota",
      status: 429,
    }),
    "quota_exhausted",
  );
  assert.equal(
    classifySafeProviderError({
      error: {
        code: "RESOURCE_EXHAUSTED",
        status: 429,
      },
    }),
    "quota_exhausted",
  );
  assert.equal(
    classifySafeProviderError({
      code: "exa_daily_search_cap",
      status: 429,
    }),
    "quota_exhausted",
  );
  assert.equal(
    isTransientProviderError({ code: "insufficient_quota", status: 429 }),
    false,
  );
});

test("configured Exa becomes the default retrieval provider", () => {
  const provider = createAiProvider({
    EXA_ENABLED: "true",
    EXA_API_KEY: "exa-key",
  });
  assert.deepEqual(provider.names, ["exa"]);
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

test("one-shot structured generation never spends a second provider attempt", async () => {
  const calls = [];
  const provider = createFallbackAiProvider(
    [
      {
        name: "openai",
        async generateStructured() {
          calls.push("openai");
          throw Object.assign(new Error("rate limit"), { status: 429 });
        },
      },
      {
        name: "gemini",
        async generateStructured() {
          calls.push("gemini");
          return { value: { ok: true } };
        },
      },
    ],
    { log: { warn() {} } },
  );

  await assert.rejects(
    provider.generateStructuredOnce({}),
    (error) =>
      error instanceof AiProvidersExhaustedError &&
      error.errors.length === 1,
  );
  assert.deepEqual(calls, ["openai"]);
});

test("normal fallback records best-effort attempts, retries one transient failure, then falls back", async () => {
  const calls = [];
  const records = [];
  const provider = createFallbackAiProvider([
    { name: "openai", model: "o", async generateStructured() { calls.push("openai"); throw Object.assign(new Error("redacted"), { status: 429 }); } },
    { name: "gemini", model: "g", async generateStructured() { calls.push("gemini"); return { provider: "gemini", model: "g", usageEvents: [] }; } },
  ], { log: { warn() {} }, sleep: async () => {}, attemptRepository: {
    async startAiProviderAttempt(input) { records.push(["start", input]); },
    async completeAiProviderAttempt(input) { records.push(["complete", input]); throw new Error("telemetry offline"); },
  } });
  assert.equal((await provider.generateStructured({ usageOperation: "editorial_draft" })).provider, "gemini");
  assert.deepEqual(calls, ["openai", "openai", "gemini"]);
  assert.equal(records.filter(([kind]) => kind === "start").length, 3);
});

test("Exa quota cap failures stop after a single provider call and do not fallback", async () => {
  const calls = [];
  const provider = createFallbackAiProvider([
    { name: "exa", async searchNews() {
      calls.push("exa");
      throw Object.assign(new Error("quota cap reached"), {
        code: "exa_daily_search_cap",
        status: 429,
      });
    } },
    { name: "openai", async searchNews() {
      calls.push("openai");
      return { provider: "openai" };
    } },
  ], { log: { warn() {} }, sleep: async () => {} });
  await assert.rejects(
    provider.searchNews({}),
    (error) =>
      error instanceof AiProvidersExhaustedError &&
      error.errors.length === 1 &&
      error.code === "ai_providers_exhausted",
  );
  assert.deepEqual(calls, ["exa"]);
});

test("non-retryable fallback failure immediately tries the next provider", async () => {
  const calls = [];
  const provider = createFallbackAiProvider([
    { name: "openai", async generateStructured() { calls.push("openai"); throw Object.assign(new Error("no"), { status: 401 }); } },
    { name: "gemini", async generateStructured() { calls.push("gemini"); return { provider: "gemini" }; } },
  ], { log: { warn() {} } });
  await provider.generateStructured({});
  assert.deepEqual(calls, ["openai", "gemini"]);
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
      error.code === "ai_providers_exhausted" && typeof error.traceId === "string",
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
  assert.deepEqual(calls, ["openai", "openai", "gemini"]);
});

test("editorial fact search uses the configured provider fallback without changing models", async () => {
  const calls = [];
  const provider = createFallbackAiProvider(
    [
      {
        name: "openai",
        async searchFact() {
          calls.push("openai");
          throw Object.assign(new Error("rate limit"), { status: 429 });
        },
      },
      {
        name: "gemini",
        async searchFact() {
          calls.push("gemini");
          return {
            provider: "gemini",
            model: "configured-gemini-model",
            fact: null,
          };
        },
      },
    ],
    { log: { warn() {} } },
  );

  const result = await provider.searchFact({ query: "one narrow fact" });
  assert.equal(result.model, "configured-gemini-model");
  assert.deepEqual(calls, ["openai", "openai", "gemini"]);
});

test("editorial fact search never falls through from Exa to a paid provider", async () => {
  const calls = [];
  const provider = createFallbackAiProvider(
    [
      {
        name: "exa",
        async searchFact() {
          calls.push("exa");
          throw Object.assign(new Error("not authorized"), { status: 401 });
        },
      },
      {
        name: "openai",
        async searchFact() {
          calls.push("openai");
          return { fact: null };
        },
      },
    ],
    { log: { warn() {} } },
  );

  await assert.rejects(
    provider.searchFact({ query: "one narrow fact" }),
    (error) =>
      error instanceof AiProvidersExhaustedError && error.errors.length === 1,
  );
  assert.deepEqual(calls, ["exa"]);
});

test("OpenAI insufficient_quota is classified as non-retryable and falls through the provider chain", async () => {
  const calls = [];
  const provider = createFallbackAiProvider([
    { name: "openai", async searchNews() {
      calls.push("openai");
      throw Object.assign(new Error("quota exceeded"), { code: "insufficient_quota", status: 429 });
    } },
    { name: "gemini", async searchNews() {
      calls.push("gemini");
      return { provider: "gemini", model: "g", items: [] };
    } },
  ], { log: { warn() {} }, sleep: async () => {} });
  await provider.searchNews({});
  assert.deepEqual(calls, ["openai", "gemini"]);
});

test("Gemini RESOURCE_EXHAUSTED is classified as non-retryable and falls through the provider chain", async () => {
  const calls = [];
  const provider = createFallbackAiProvider([
    {
      name: "gemini",
      async searchNews() {
        calls.push("gemini");
        throw Object.assign(new Error("quota consumed"), {
          error: { code: "RESOURCE_EXHAUSTED", status: 429 },
        });
      },
    },
    { name: "openai", async searchNews() {
      calls.push("openai");
      return { provider: "openai", model: "o", items: [] };
    } },
  ], { log: { warn() {} }, sleep: async () => {} });
  await provider.searchNews({});
  assert.deepEqual(calls, ["gemini", "openai"]);
});

test("Exa fact search persists only safe success telemetry", async () => {
  const records = [];
  const provider = createFallbackAiProvider([{ name: "exa", model: "exa-search:auto", async searchFact() {
    return { fact: { claim: "private article body", evidenceText: "private evidence" }, usageEvents: [{ providerResponseId: "exa-response-1", inputTokens: 1, outputTokens: 2 }] };
  } }], { log: { warn() {} }, attemptRepository: {
    async startAiProviderAttempt(input) { records.push(input); },
    async completeAiProviderAttempt(input) { records.push(input); },
  } });
  await provider.searchFact({ query: "private article body", expectedClaim: "private evidence" });
  assert.equal(records.length, 2);
  assert.equal(records[0].operation, "searchFact");
  assert.equal(records[1].status, "succeeded");
  assert.doesNotMatch(JSON.stringify(records), /private article body|private evidence/);
});

test("Exa fact search retries one transient failure without a paid fallback", async () => {
  const calls = [];
  const provider = createFallbackAiProvider([
    { name: "exa", async searchFact() { calls.push("exa"); if (calls.length === 1) throw Object.assign(new Error("rate limited"), { status: 429 }); return { fact: null }; } },
    { name: "openai", async searchFact() { calls.push("openai"); return { fact: null }; } },
  ], { log: { warn() {} }, sleep: async () => {} });
  await provider.searchFact({ query: "one narrow fact" });
  assert.deepEqual(calls, ["exa", "exa"]);
});

test("Exa fact search does not retry a non-transient failure", async () => {
  const calls = [];
  const provider = createFallbackAiProvider([{ name: "exa", async searchFact() {
    calls.push("exa"); throw Object.assign(new Error("forbidden"), { status: 403 });
  } }], { log: { warn() {} }, sleep: async () => {} });
  await assert.rejects(provider.searchFact({ query: "one narrow fact" }));
  assert.deepEqual(calls, ["exa"]);
});
