import assert from "node:assert/strict";
import test from "node:test";

import type {
  AiUsageEventRow,
  RecordAiUsageInput,
} from "../../src/usage/usage-persistence.contracts.js";

import {
  classifySafeProviderError,
  isTransientProviderError,
  safeAttemptDiagnostics,
  toStartInput,
  persistStartAiProviderAttempt,
  persistCompleteAiProviderAttempt,
} from "../../src/telemetry/ai-provider-attempts.adapters.js";
import {
  estimateOpenAiCost,
  exaUsageEvent,
  geminiUsageEvent,
  openAiUsageEvent,
  recordAiUsageEvents,
} from "../../src/telemetry/ai-usage.adapters.js";

test("typed attempt telemetry preserves semantic fields and redacts error identity", () => {
  const started = new Date("2026-08-22T00:00:00.000Z");
  const start = toStartInput({
    id: "attempt-1",
    correlationId: "corr-1",
    operation: "editorial_draft",
    provider: "openai",
    model: "gpt-5.4",
    attemptNumber: 1,
    startedAt: started.toISOString(),
  });
  assert.equal(start.id, "attempt-1");
  assert.equal(start.provider, "openai");
  assert.equal(start.attemptNumber, 1);

  const failure = safeAttemptDiagnostics(
    Object.assign(new Error("oops"), {
      providerDiagnostics: { providerResponseId: "resp_1", refusal: false },
    }),
  );
  assert.equal(failure.errorCode, "provider_failed");
  assert.equal(failure.providerResponseId, "resp_1");
  assert.equal(failure.refusal, false);
});

test("attempt adapter persists best-effort and does not fail on storage errors", async () => {
  const warnings: string[] = [];
  const repository = {
    async startAiProviderAttempt() {
      throw new Error("storage down");
    },
    async completeAiProviderAttempt() {
      throw new Error("storage down");
    },
  };
  const result = await persistStartAiProviderAttempt(
    repository,
    {
      id: "attempt-2",
      correlationId: "corr-2",
      operation: "editorial_draft",
      provider: "openai",
      model: "gpt-5.4",
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
    },
    { warn: (message) => warnings.push(message) },
  );
  const failure = await persistCompleteAiProviderAttempt(
    repository as unknown as typeof repository,
    {
      id: "attempt-2",
      status: "failed",
      completedAt: new Date().toISOString(),
      latencyMs: 25,
      error: Object.assign(new Error("upstream fail"), { status: 502 }),
    },
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(result, null);
  assert.equal(failure, null);
  assert.equal(isTransientProviderError({ status: 408 }), true);
  assert.equal(
    classifySafeProviderError({ code: "invalid-response" }),
    "invalid_response",
  );
  assert.equal(classifySafeProviderError({ code: "rate-limited" }), "rate_limited");
  assert.equal(isTransientProviderError({ code: "network-error" }), true);
  assert.equal(warnings.length, 2);
});

test("attempt completion persists only the canonical boundary fields", async () => {
  const completions: Array<Record<string, unknown>> = [];
  const repository = {
    async startAiProviderAttempt() {
      return null;
    },
    async completeAiProviderAttempt(input: unknown) {
      completions.push(input as Record<string, unknown>);
      return input;
    },
  };
  await persistCompleteAiProviderAttempt(repository, {
    id: "attempt-3",
    status: "succeeded",
    completedAt: "2026-08-22T00:00:01.000Z",
    latencyMs: 1000,
    result: {
      usageEvents: [
        {
          providerResponseId: "resp-3",
          inputTokens: 3,
          outputTokens: 2,
          reasoningTokens: 1,
        },
      ],
    },
  });
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.providerResponseId, "resp-3");
  assert.equal(completions[0]?.inputTokens, 3);
  assert.equal("result" in (completions[0] ?? {}), false);
  assert.equal("error" in (completions[0] ?? {}), false);
});

test("OpenAI/Gemini/Exa usage normalization preserves model, operation and null-safe cost", async () => {
  assert.equal(
    estimateOpenAiCost({ model: "future-model", inputTokens: 100 }).estimatedCostUsd,
    null,
  );
  const openAiEvent = openAiUsageEvent(
    {
      id: "resp-openai",
      output: [{ type: "web_search_call" }, { type: "web_search_call" }],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
    { model: "gpt-5.4-2026-03-05", operation: "news_search" },
  );
  assert.equal(openAiEvent?.provider, "openai");
  assert.equal(openAiEvent?.webSearchCalls, 2);
  assert.equal(openAiEvent?.estimatedCostUsd, 0.0205275);
  assert.equal(openAiEvent?.pricing?.tier, "standard");

  const geminiEvent = geminiUsageEvent(
    {
      responseId: "resp-gemini",
      candidates: [{ groundingMetadata: { webSearchQueries: ["one", "two"] } }],
      usageMetadata: {
        promptTokenCount: 40,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 1,
      },
    },
    { model: "gemini-2.5-flash", operation: "news_search" },
  );
  assert.ok(geminiEvent);
  assert.equal(geminiEvent.provider, "gemini");
  assert.equal(geminiEvent.webSearchCalls, 2);
  assert.equal(geminiEvent.estimatedCostUsd, null);
  assert.equal(
    geminiUsageEvent(
      {},
      { model: "gemini-2.5-flash", operation: "news_search" },
    ),
    null,
  );

  const exaEvent = exaUsageEvent(
    { requestId: "exa-1" },
    { model: "exa", operation: "news_search" },
  );
  assert.equal(exaEvent.provider, "exa");
  assert.equal(exaEvent.webSearchCalls, 1);
  assert.equal(exaEvent.inputTokens, 0);
});

test("usage persistence helper is best effort and continues on row conflicts", async () => {
  const rows: AiUsageEventRow[] = [];
  const repository = {
    async recordAiUsage(input: RecordAiUsageInput): Promise<AiUsageEventRow> {
      if (input.provider === "openai") throw new Error("already exists");
      const row: AiUsageEventRow = {
        id: String(rows.length + 1),
        provider: input.provider,
        provider_response_id: input.providerResponseId ?? null,
        model: input.model,
        operation: input.operation,
        telegram_channel_id: input.telegramChannelId ?? null,
        search_run_id: input.searchRunId ?? null,
        article_id: input.articleId ?? null,
        input_tokens: input.inputTokens ?? 0,
        cached_input_tokens: input.cachedInputTokens ?? 0,
        output_tokens: input.outputTokens ?? 0,
        reasoning_tokens: input.reasoningTokens ?? 0,
        web_search_calls: input.webSearchCalls ?? 0,
        estimated_cost_usd: "0.00",
        pricing_snapshot: input.pricingSnapshot ?? null,
        created_at: "2026-08-22T00:00:00.000Z",
      };
      rows.push(row);
      return row;
    },
  };
  const result = await recordAiUsageEvents(
    repository,
    [
      {
        provider: "openai",
        providerResponseId: "resp-1",
        model: "gpt-5.4",
        operation: "news_search",
        inputTokens: 1,
        cachedInputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        webSearchCalls: 0,
        estimatedCostUsd: 0.001,
        pricing: null,
      },
      {
        provider: "gemini",
        providerResponseId: "resp-2",
        model: "gemini-2.5-flash",
        operation: "news_search",
        inputTokens: 2,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningTokens: 1,
        webSearchCalls: 1,
        estimatedCostUsd: null,
        pricing: null,
      },
    ],
    {
      channelId: "@channel",
      searchRunId: "search-1",
      articleId: "article-1",
    },
  );
  assert.equal(result.length, 1);
  assert.equal(rows.length, 1);
});
