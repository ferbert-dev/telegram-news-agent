const PER_MILLION = 1_000_000;
const WEB_SEARCH_CALL_USD = 10 / 1_000;

const OPENAI_STANDARD_PRICING = Object.freeze([
  {
    match: /^gpt-5\.6-sol(?:-|$)/,
    input: 5,
    cachedInput: 0.5,
    output: 30,
  },
  {
    match: /^gpt-5\.6-terra(?:-|$)/,
    input: 2,
    cachedInput: 0.2,
    output: 12,
  },
  {
    match: /^gpt-5\.6-luna(?:-|$)/,
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
  },
  {
    match: /^gpt-5\.4-mini(?:-|$)/,
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5,
  },
  {
    match: /^gpt-5\.4-nano(?:-|$)/,
    input: 0.2,
    cachedInput: 0.02,
    output: 1.25,
  },
  {
    match: /^gpt-5\.4(?:-\d{4}|$)/,
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
  },
]);

function nonNegativeInteger(value) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function getOpenAiStandardPricing(model) {
  const price = OPENAI_STANDARD_PRICING.find(({ match }) =>
    match.test(String(model ?? "")),
  );
  if (!price) return null;
  return Object.freeze({
    inputUsdPerMillion: price.input,
    cachedInputUsdPerMillion: price.cachedInput,
    outputUsdPerMillion: price.output,
    webSearchUsdPerCall: WEB_SEARCH_CALL_USD,
    tier: "standard",
    context: "short",
    source: "openai-pricing-2026-08-07",
  });
}

export function estimateOpenAiCost({
  model,
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  webSearchCalls = 0,
}) {
  const pricing = getOpenAiStandardPricing(model);
  if (!pricing) return { estimatedCostUsd: null, pricing: null };
  const input = nonNegativeInteger(inputTokens);
  const cached = Math.min(input, nonNegativeInteger(cachedInputTokens));
  const uncached = input - cached;
  const output = nonNegativeInteger(outputTokens);
  const searches = nonNegativeInteger(webSearchCalls);
  const estimatedCostUsd =
    (uncached * pricing.inputUsdPerMillion) / PER_MILLION +
    (cached * pricing.cachedInputUsdPerMillion) / PER_MILLION +
    (output * pricing.outputUsdPerMillion) / PER_MILLION +
    searches * pricing.webSearchUsdPerCall;
  return {
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
    pricing,
  };
}

export function openAiUsageEvent(response, { model, operation }) {
  const usage = response?.usage;
  const webSearchCalls = Array.isArray(response?.output)
    ? response.output.filter((item) => item?.type === "web_search_call").length
    : 0;
  if (!usage && webSearchCalls === 0) return null;
  const inputTokens = nonNegativeInteger(usage?.input_tokens);
  const cachedInputTokens = nonNegativeInteger(
    usage?.input_tokens_details?.cached_tokens,
  );
  const outputTokens = nonNegativeInteger(usage?.output_tokens);
  const reasoningTokens = nonNegativeInteger(
    usage?.output_tokens_details?.reasoning_tokens,
  );
  const cost = estimateOpenAiCost({
    model,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    webSearchCalls,
  });
  return {
    provider: "openai",
    providerResponseId: response?.id ?? null,
    model,
    operation,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    webSearchCalls,
    ...cost,
  };
}

export function geminiUsageEvent(response, { model, operation }) {
  const usage = response?.usageMetadata;
  const queries = response?.candidates?.flatMap(
    (candidate) => candidate?.groundingMetadata?.webSearchQueries ?? [],
  );
  const webSearchCalls = Array.isArray(queries) ? queries.length : 0;
  if (!usage && webSearchCalls === 0) return null;
  return {
    provider: "gemini",
    providerResponseId: response?.responseId ?? null,
    model,
    operation,
    inputTokens: nonNegativeInteger(usage?.promptTokenCount),
    cachedInputTokens: nonNegativeInteger(usage?.cachedContentTokenCount),
    outputTokens: nonNegativeInteger(usage?.candidatesTokenCount),
    reasoningTokens: nonNegativeInteger(usage?.thoughtsTokenCount),
    webSearchCalls,
    estimatedCostUsd: null,
    pricing: null,
  };
}

export async function recordAiUsageEvents(
  repository,
  usageEvents,
  { channelId = null, searchRunId = null, articleId = null } = {},
) {
  if (typeof repository?.recordAiUsage !== "function") return [];
  const recorded = [];
  for (const usage of usageEvents ?? []) {
    if (!usage) continue;
    try {
      const row = await repository.recordAiUsage({
        provider: usage.provider,
        providerResponseId: usage.providerResponseId,
        model: usage.model,
        operation: usage.operation,
        telegramChannelId: channelId,
        searchRunId,
        articleId,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        webSearchCalls: usage.webSearchCalls,
        estimatedCostUsd: usage.estimatedCostUsd,
        pricingSnapshot: usage.pricing,
      });
      if (row) recorded.push(row);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "ai_usage_record_failed",
          provider: usage.provider,
          operation: usage.operation,
          error_code: "usage_write_failed",
        }),
      );
    }
  }
  return recorded;
}
