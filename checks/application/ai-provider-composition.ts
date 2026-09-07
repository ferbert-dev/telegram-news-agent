import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";

import {
  AiProvidersExhaustedError,
  createFallbackAiProvider,
  getAiProviderOrder,
} from "../../src/ai/ai-provider-composition.js";
import { createFallbackAiProvider as createLegacyFallbackAiProvider } from "../../src/ai-provider.js";
import { AiProvidersModule } from "../../src/ai/ai-providers.module.js";
import { AI_PROVIDER, GEMINI_CLIENT, GEMINI_SDK } from "../../src/ai/ai-provider.tokens.js";

test("typed composition preserves configured order and retries only transient failures", async () => {
  const calls: string[] = [];
  const provider = createFallbackAiProvider([
    { name: "openai", async searchNews() {
      calls.push("openai");
      throw Object.assign(new Error("rate limited"), { status: 429 });
    } },
    { name: "gemini", async searchNews() { calls.push("gemini"); return { provider: "gemini" }; } },
  ], { log: { warn() {} }, sleep: async () => {} });
  assert.equal((await provider.searchNews({})).provider, "gemini");
  assert.deepEqual(calls, ["openai", "openai", "openai", "gemini"]);
  assert.deepEqual(getAiProviderOrder({}), ["openai", "gemini"]);
});

test("typed composition retains Exa cap and one-shot boundaries", async () => {
  const calls: string[] = [];
  const provider = createFallbackAiProvider([
    { name: "exa", async searchFact() {
      calls.push("exa");
      throw Object.assign(new Error("cap"), { code: "exa_daily_search_cap", status: 429 });
    } },
    { name: "openai", async searchFact() { calls.push("openai"); return { provider: "openai" }; } },
  ], { log: { warn() {} }, sleep: async () => {} });
  await assert.rejects(provider.searchFact({}), AiProvidersExhaustedError);
  assert.deepEqual(calls, ["exa"]);
});

test("typed Exa fact search remains sequential and is never deadline-raced", async () => {
  let calls = 0;
  let scheduledTimeouts = 0;
  const provider = createFallbackAiProvider([
    { name: "exa", async searchFact() {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("network"), { code: "ECONNRESET" });
      return { provider: "exa" };
    } },
  ], {
    log: { warn() {} },
    sleep: async () => {},
    setTimeoutImpl() {
      scheduledTimeouts += 1;
      return scheduledTimeouts;
    },
  });
  assert.equal((await provider.searchFact({})).provider, "exa");
  assert.equal(calls, 2);
  assert.equal(scheduledTimeouts, 0);
});

test("Exa retry cap hard-stops before a paid fallback", async () => {
  const calls: string[] = [];
  const provider = createFallbackAiProvider([
    { name: "exa", async searchNews() {
      calls.push("exa");
      if (calls.length === 1) throw Object.assign(new Error("network"), { code: "ECONNRESET" });
      throw Object.assign(new Error("cap"), { code: "exa_daily_search_cap", status: 429 });
    } },
    { name: "openai", async searchNews() { calls.push("openai"); return { provider: "openai" }; } },
  ], { log: { warn() {} }, sleep: async () => {} });
  await assert.rejects(provider.searchNews({}), AiProvidersExhaustedError);
  assert.deepEqual(calls, ["exa", "exa"]);
});

test("typed composition preserves legacy fallback result and attempt order", async () => {
  const typedCalls: string[] = [];
  const legacyCalls: string[] = [];
  const createProviders = (calls: string[]) => [
    { name: "openai" as const, async generateStructured() {
      calls.push("openai");
      if (calls.length === 1) throw Object.assign(new Error("rate"), { status: 429 });
      return { provider: "openai", model: "o" };
    } },
    { name: "gemini" as const, async generateStructured() { calls.push("gemini"); return { provider: "gemini", model: "g" }; } },
  ];
  const typed = await createFallbackAiProvider(createProviders(typedCalls), { log: { warn() {} }, sleep: async () => {} }).generateStructured({});
  const legacy = await createLegacyFallbackAiProvider(createProviders(legacyCalls), { log: { warn() {} } as Console, sleep: async () => {} }).generateStructured({});
  assert.deepEqual(typed, legacy);
  assert.deepEqual(typedCalls, legacyCalls);
});

test("typed composition preserves legacy full transient retry exhaustion", async () => {
  const typedCalls: string[] = [];
  const legacyCalls: string[] = [];
  const typedDelays: number[] = [];
  const legacyDelays: number[] = [];
  const createProviders = (calls: string[]) => [
    { name: "openai" as const, async searchNews() {
      calls.push("openai");
      throw Object.assign(new Error("rate"), { status: 429 });
    } },
    { name: "gemini" as const, async searchNews() {
      calls.push("gemini");
      return { provider: "gemini" };
    } },
  ];
  const typed = createFallbackAiProvider(createProviders(typedCalls), {
    log: { warn() {} },
    random: () => 0.5,
    sleep: async (delayMs) => { typedDelays.push(delayMs); },
  });
  const legacy = createLegacyFallbackAiProvider(createProviders(legacyCalls), {
    log: { warn() {} } as Console,
    random: () => 0.5,
    sleep: async (delayMs) => { legacyDelays.push(delayMs); },
  });
  assert.deepEqual(await typed.searchNews({}), await legacy.searchNews({}));
  assert.deepEqual(typedCalls, ["openai", "openai", "openai", "gemini"]);
  assert.deepEqual(typedCalls, legacyCalls);
  assert.deepEqual(typedDelays, [250, 500]);
  assert.deepEqual(typedDelays, legacyDelays);
});

test("typed composition fails fast before provider work when already cancelled", async () => {
  const calls: string[] = [];
  const cancellation = new Error("lease lost");
  cancellation.name = "AbortError";
  const controller = new AbortController();
  controller.abort(cancellation);
  const provider = createFallbackAiProvider([
    { name: "openai", async searchNews() { calls.push("openai"); return { provider: "openai" }; } },
    { name: "gemini", async searchNews() { calls.push("gemini"); return { provider: "gemini" }; } },
  ], { log: { warn() {} } });
  await assert.rejects(provider.searchNews({ signal: controller.signal }), (error) => error === cancellation);
  assert.deepEqual(calls, []);
});

test("typed composition stops retries and fallback after mid-operation cancellation", async () => {
  const calls: string[] = [];
  const cancellation = new Error("lease lost");
  cancellation.name = "AbortError";
  const controller = new AbortController();
  const provider = createFallbackAiProvider([
    { name: "openai", async searchNews() {
      calls.push("openai");
      queueMicrotask(() => controller.abort(cancellation));
      return new Promise<never>(() => {});
    } },
    { name: "gemini", async searchNews() { calls.push("gemini"); return { provider: "gemini" }; } },
  ], {
    log: { warn() {} },
    setTimeoutImpl() { return 1; },
    clearTimeoutImpl() {},
  });
  await assert.rejects(provider.searchNews({ signal: controller.signal }), (error) => error === cancellation);
  assert.deepEqual(calls, ["openai"]);
});

test("typed composition uses fresh per-provider AbortSignal and bounded fallback windows", async () => {
  const signals: Array<AbortSignal | null> = [];
  const scheduledDelays: number[] = [];
  const provider = createFallbackAiProvider([
    { name: "openai", async searchNews(input: { signal?: AbortSignal }) {
      signals.push(input.signal ?? null);
      return new Promise<never>(() => {});
    } },
    { name: "gemini", async searchNews(input: { signal?: AbortSignal }) {
      signals.push(input.signal ?? null);
      return { provider: "gemini" };
    } },
  ], {
    log: { warn() {} },
    sleep: async () => {},
    providerDeadlineMs: 25,
    setTimeoutImpl(callback, delayMs) {
      scheduledDelays.push(delayMs);
      if (scheduledDelays.length === 1) queueMicrotask(callback);
      return scheduledDelays.length;
    },
    clearTimeoutImpl() {},
  });
  const result = await provider.searchNews({});
  assert.equal(result.provider, "gemini");
  assert.equal(signals.length, 2);
  assert.equal(signals[0] instanceof AbortSignal, true);
  assert.equal(signals[1] instanceof AbortSignal, true);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  assert.equal(scheduledDelays.length, 2);
  assert.ok(scheduledDelays.every((delay) => delay >= 0 && delay <= 25));
});

test("Nest composition instantiates SDKs only through Symbol ports and leaves Gemini optional", async () => {
  const module = await Test.createTestingModule({
    imports: [AiProvidersModule.register({ env: { OPENAI_API_KEY: "test-key" } })],
  }).compile();
  try {
    assert.deepEqual(module.get(AI_PROVIDER).names, ["openai"]);
  } finally {
    await module.close();
  }
});

test("Gemini client uses the injected SDK Symbol override", async () => {
  const sdk = { models: { generateContent: async () => ({}) } };
  const builder = Test.createTestingModule({
    imports: [AiProvidersModule.register({ env: { GEMINI_API_KEY: "test-key" } })],
  });
  const module = await builder.overrideProvider(GEMINI_SDK).useValue(sdk).compile();
  try {
    assert.equal(module.get(GEMINI_CLIENT).client, sdk);
  } finally {
    await module.close();
  }
});

test("a rejected credential takes a provider out of rotation instead of being retried forever", async () => {
  // A 401 is not a throttle, so it never opened the breaker: an invalid key was
  // retried three times on every single call, for the life of the process.
  // Measured on the integration stage as 1,967 rejections that produced
  // nothing and delayed every call by ~680ms before the fallback was tried.
  const calls: string[] = [];
  const rejecting = {
    name: "openai",
    async generateStructured() {
      calls.push("openai");
      const error = new Error("Incorrect API key provided") as Error & { code: string };
      error.code = "authentication_failed";
      throw error;
    },
  };
  const working = {
    name: "gemini",
    async generateStructured() {
      calls.push("gemini");
      return { ok: true };
    },
  };

  const provider = createFallbackAiProvider([rejecting, working] as never, {
    log: { info() {}, warn() {}, error() {} },
    attemptRepository: null,
    retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
  } as never);

  for (let call = 0; call < 8; call += 1) {
    await provider.generateStructured({ prompt: `call-${call}` } as never);
  }

  const openaiCalls = calls.filter((name) => name === "openai").length;
  const geminiCalls = calls.filter((name) => name === "gemini").length;

  assert.equal(geminiCalls, 8, "every call must still be served by the working provider");
  // Two calls' worth of rejection is conclusive for a deterministic 401, so the
  // provider is skipped from the third call on. Without the break this would be
  // 8 calls x 3 attempts = 24.
  assert.ok(
    openaiCalls <= 6,
    `a rejected credential must stop being asked; it was attempted ${openaiCalls} times across 8 calls`,
  );
});

test("a long operation gets its own deadline, not the default one", async () => {
  // Editorial enrichment took 23 seconds on Gemini when it succeeded. Against
  // a 30-second ceiling that is not a margin. On the integration stage Gemini
  // then hit its quota, every enrichment fell to OpenAI, and the ledger
  // recorded seven timeouts at exactly the deadline -- so the editorial pass
  // never ran, and three published articles were the untouched baseline while
  // the prompt driving them was being rewritten.
  const deadlines: number[] = [];
  const provider = {
    name: "slow",
    model: "m",
    async generateStructured() {
      return { value: {}, usageEvents: [] };
    },
  };
  const composed = createFallbackAiProvider([provider as never], {
    log: { warn() {}, error() {}, info() {} } as never,
    setTimeoutImpl: (_callback: () => void, delayMs: number) => {
      deadlines.push(delayMs);
      return 0;
    },
    clearTimeoutImpl: () => undefined,
  });

  await composed.generateStructured({ usageOperation: "editorial_enrichment" });
  await composed.generateStructured({ usageOperation: "feed_candidate_curation" });

  assert.equal(deadlines[0], 90_000, "enrichment gets the long deadline");
  assert.equal(deadlines[1], 30_000, "everything else keeps the default");
});
