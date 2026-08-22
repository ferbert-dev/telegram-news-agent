import assert from "node:assert/strict";

const composition = await import("../dist/ai/ai-provider-composition.js");
const adapters = await import("../dist/ai/ai-provider.adapters.js");
const tokens = await import("../dist/ai/ai-provider.tokens.js");

assert.deepEqual(composition.getAiProviderOrder({}), ["openai", "gemini"]);
assert.equal(typeof composition.createFallbackAiProvider, "function");
assert.equal(typeof adapters.createOpenAiProviderAdapter, "function");
assert.equal(typeof tokens.AI_PROVIDER, "symbol");
