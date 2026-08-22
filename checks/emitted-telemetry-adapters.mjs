import assert from "node:assert/strict";

const usage = await import("../dist/telemetry/ai-usage.adapters.js");
const attempts = await import("../dist/telemetry/ai-provider-attempts.adapters.js");

const openAi = usage.openAiUsageEvent(
  {
    id: "resp-1",
    output: [{ type: "web_search_call" }],
    usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
  },
  { model: "gpt-5.4-2026-03-05", operation: "test" },
);

const gemini = usage.geminiUsageEvent(
  { responseId: "resp-2", candidates: [], usageMetadata: {} },
  { model: "gemini-2.5-flash", operation: "test" },
);

assert.equal(openAi?.provider, "openai");
assert.equal(gemini?.provider, "gemini");
assert.equal(typeof usage.estimateOpenAiCost({ model: "gpt-5.4-2026-03-05", inputTokens: 20 }).estimatedCostUsd, "number");
assert.equal(attempts.classifySafeProviderError({ status: 429 }), "rate_limited");
assert.equal(typeof attempts.newAttemptId(), "string");
