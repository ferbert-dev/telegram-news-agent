import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateOpenAiCost,
  openAiUsageEvent,
} from "../src/ai-usage.js";

test("OpenAI usage calculates standard token and web-search list cost", () => {
  const result = estimateOpenAiCost({
    model: "gpt-5.4-2026-03-05",
    inputTokens: 10_000,
    cachedInputTokens: 2_000,
    outputTokens: 1_000,
    webSearchCalls: 2,
  });
  assert.equal(result.estimatedCostUsd, 0.0555);
  assert.equal(result.pricing.inputUsdPerMillion, 2.5);
  assert.equal(result.pricing.webSearchUsdPerCall, 0.01);
});

test("OpenAI response usage preserves reasoning and counts web-search calls", () => {
  const event = openAiUsageEvent(
    {
      id: "resp_1",
      output: [
        { type: "web_search_call" },
        { type: "message" },
        { type: "web_search_call" },
      ],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 30 },
      },
    },
    { model: "gpt-5.4-2026-03-05", operation: "news_search" },
  );
  assert.deepEqual(
    {
      responseId: event.providerResponseId,
      input: event.inputTokens,
      cached: event.cachedInputTokens,
      output: event.outputTokens,
      reasoning: event.reasoningTokens,
      searches: event.webSearchCalls,
    },
    {
      responseId: "resp_1",
      input: 100,
      cached: 20,
      output: 50,
      reasoning: 30,
      searches: 2,
    },
  );
});

test("unknown model keeps usage but does not invent a price", () => {
  assert.equal(
    estimateOpenAiCost({ model: "future-model", inputTokens: 100 })
      .estimatedCostUsd,
    null,
  );
});
