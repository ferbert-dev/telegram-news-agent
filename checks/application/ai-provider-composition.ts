import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";

import {
  AiProvidersExhaustedError,
  createFallbackAiProvider,
  getAiProviderOrder,
} from "../../src/ai/ai-provider-composition.js";
import { AiProvidersModule } from "../../src/ai/ai-providers.module.js";
import { AI_PROVIDER } from "../../src/ai/ai-provider.tokens.js";

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
