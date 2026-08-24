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

test("classifies OpenAI JSON-schema validation errors as invalid_schema", () => {
  assert.equal(
    classifySafeProviderError({
      status: 400,
      error: { param: "text.format.schema" },
    }),
    "invalid_schema",
  );
  assert.equal(
    classifySafeProviderError({
      status: 400,
      error: { code: "invalid_json_schema" },
    }),
    "invalid_schema",
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

test("Gemini transient failures use the production retry count and exponential delays", async () => {
  const calls = [];
  const delays = [];
  let nowMs = 0;
  const provider = createFallbackAiProvider([
    {
      name: "gemini",
      model: "gemini",
      async generateStructured() {
        calls.push("gemini");
        throw Object.assign(new Error("temporarily down"), { status: 503 });
      },
    },
  ], {
    log: { warn() {} },
    now: () => new Date(nowMs),
    sleep: async (delayMs) => {
      delays.push(delayMs);
      nowMs += delayMs;
    },
    random: () => 0.5,
  });

  const error = await provider.generateStructured({}).catch(
    (value) => value,
  );
  assert.ok(error instanceof AiProvidersExhaustedError);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("operation deadline aborts a hanging provider and prevents later retries", async () => {
  const calls = [];
  const records = [];
  let receivedSignal;
  let scheduledDelay;
  const provider = createFallbackAiProvider(
    [
      {
        name: "openai",
        async generateStructured({ signal }) {
          calls.push("openai");
          receivedSignal = signal;
          return new Promise(() => {});
        },
      },
      {
        name: "gemini",
        async generateStructured() {
          calls.push("gemini");
          return { provider: "gemini" };
        },
      },
    ],
    {
      log: { warn() {} },
      retry: { operationDeadlineMs: 25 },
      setTimeoutImpl(callback, delayMs) {
        scheduledDelay = delayMs;
        queueMicrotask(callback);
        return 1;
      },
      clearTimeoutImpl() {},
      attemptRepository: {
        async startAiProviderAttempt(record) {
          records.push(["start", record]);
        },
        async completeAiProviderAttempt(record) {
          records.push(["complete", record]);
        },
      },
    },
  );

  await assert.rejects(
    provider.generateStructured({}),
    (error) => error instanceof AiProvidersExhaustedError,
  );
  assert.deepEqual(calls, ["openai"]);
  assert.equal(receivedSignal.aborted, true);
  assert.ok(scheduledDelay >= 0 && scheduledDelay <= 25);
  assert.equal(records.filter(([kind, record]) => kind === "complete" && record.status === "succeeded").length, 0);
  assert.equal(records.filter(([kind, record]) => kind === "complete" && record.status === "failed").length, 1);
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

test("normal fallback records best-effort attempts, retries transient failures, then falls back", async () => {
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
  assert.deepEqual(calls, ["openai", "openai", "openai", "gemini"]);
  assert.equal(records.filter(([kind]) => kind === "start").length, 4);
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
  assert.deepEqual(calls, ["openai", "openai", "openai", "gemini"]);
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
  assert.deepEqual(calls, ["openai", "openai", "openai", "gemini"]);
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

test("a hanging Exa fact search never starts an overlapping paid retry", async () => {
  let resolveSearch;
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  let scheduledTimeouts = 0;
  const provider = createFallbackAiProvider(
    [{
      name: "exa",
      async searchFact() {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          resolveSearch = (value) => {
            inFlight -= 1;
            resolve(value);
          };
        });
      },
    }],
    {
      log: { warn() {} },
      retry: { operationDeadlineMs: 1 },
      setTimeoutImpl(callback) {
        scheduledTimeouts += 1;
        queueMicrotask(callback);
        return scheduledTimeouts;
      },
      clearTimeoutImpl() {},
    },
  );

  const pending = provider.searchFact({ query: "one narrow fact" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(maxInFlight, 1);
  assert.equal(scheduledTimeouts, 0);

  resolveSearch({ fact: null });
  await pending;
  assert.equal(inFlight, 0);
});

test("Exa fact search does not retry a non-transient failure", async () => {
  const calls = [];
  const provider = createFallbackAiProvider([{ name: "exa", async searchFact() {
    calls.push("exa"); throw Object.assign(new Error("forbidden"), { status: 403 });
  } }], { log: { warn() {} }, sleep: async () => {} });
  await assert.rejects(provider.searchFact({ query: "one narrow fact" }));
  assert.deepEqual(calls, ["exa"]);
});
