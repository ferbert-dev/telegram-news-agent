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
  assert.deepEqual(calls, ["openai", "openai", "gemini"]);
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
