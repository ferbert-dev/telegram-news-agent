import type {
  RecordAiUsageInput,
  UsageReportingPersistence,
} from "../usage/usage-persistence.contracts.js";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = {
  [key: string]: JsonValue;
};

export type UsageEventLogger = {
  warn: (message: string) => void;
};

export type RecordAiUsageRepository = Pick<
  UsageReportingPersistence,
  "recordAiUsage"
>;

type UsageEventResponse = {
  providerResponseId?: string | null;
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  webSearchCalls: number;
  estimatedCostUsd: number | null;
  pricing: JsonObject | null;
};

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

function nonNegativeInteger(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function getOpenAiStandardPricing(model: string | null | undefined) {
  const pricing = OPENAI_STANDARD_PRICING.find(({ match }) =>
    match.test(String(model ?? "")),
  );
  if (!pricing) return null;
  return Object.freeze({
    inputUsdPerMillion: pricing.input,
    cachedInputUsdPerMillion: pricing.cachedInput,
    outputUsdPerMillion: pricing.output,
    webSearchUsdPerCall: WEB_SEARCH_CALL_USD,
    tier: "standard",
    context: "short",
    source: "openai-pricing-2026-08-07",
  } as const);
}

export function estimateOpenAiCost({
  model,
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  webSearchCalls = 0,
}: {
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  webSearchCalls?: number;
}): {
  estimatedCostUsd: number | null;
  pricing: ReturnType<typeof getOpenAiStandardPricing>;
} {
  const pricing = getOpenAiStandardPricing(model);
  if (!pricing) return { estimatedCostUsd: null, pricing: null };
  const input = nonNegativeInteger(inputTokens);
  const cachedInput = Math.min(input, nonNegativeInteger(cachedInputTokens));
  const uncachedInput = input - cachedInput;
  const output = nonNegativeInteger(outputTokens);
  const searches = nonNegativeInteger(webSearchCalls);
  const estimatedCostUsd =
    (uncachedInput * pricing.inputUsdPerMillion) / PER_MILLION +
    (cachedInput * pricing.cachedInputUsdPerMillion) / PER_MILLION +
    (output * pricing.outputUsdPerMillion) / PER_MILLION +
    searches * pricing.webSearchUsdPerCall;
  return {
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
    pricing,
  };
}

export function openAiUsageEvent(
  response: { id?: string | null; output?: unknown[]; usage?: unknown },
  {
    model,
    operation,
  }: {
    model: string;
    operation: string;
  },
): UsageEventResponse | null {
  const output = Array.isArray(response?.output)
    ? response.output
    : [];
  const usage = response?.usage as { input_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown }; output_tokens?: unknown; output_tokens_details?: { reasoning_tokens?: unknown } } | null;
  const webSearchCalls = output.filter(
    (item) => (item as { type?: unknown })?.type === "web_search_call",
  ).length;
  if (!usage && webSearchCalls === 0) return null;
  const inputTokens = nonNegativeInteger(usage?.input_tokens);
  const cachedInputTokens = nonNegativeInteger(usage?.input_tokens_details?.cached_tokens);
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
    estimatedCostUsd: cost.estimatedCostUsd,
    pricing: cost.pricing,
  };
}

export function geminiUsageEvent(
  response: { responseId?: string | null; candidates?: unknown[]; usageMetadata?: unknown },
  {
    model,
    operation,
  }: {
    model: string;
    operation: string;
  },
): UsageEventResponse | null {
  const usage = response?.usageMetadata as {
    promptTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
  };
  const queries = response.candidates?.flatMap(
    (candidate) =>
      (candidate as { groundingMetadata?: { webSearchQueries?: unknown[] } })
        .groundingMetadata?.webSearchQueries ?? [],
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

export function exaUsageEvent(
  response: { requestId?: string | null; id?: string | null },
  {
    model,
    operation,
  }: {
    model: string;
    operation: string;
  },
): UsageEventResponse {
  return {
    provider: "exa",
    providerResponseId: response?.requestId ?? response?.id ?? null,
    model,
    operation,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    webSearchCalls: 1,
    estimatedCostUsd: null,
    pricing: null,
  };
}

export async function recordAiUsageEvents(
  repository: RecordAiUsageRepository | null | undefined,
  usageEvents: Array<UsageEventResponse | null> | null | undefined,
  {
    channelId = null,
    searchRunId = null,
    articleId = null,
  }: {
    channelId?: string | null;
    searchRunId?: string | null;
    articleId?: string | null;
  } = {},
  logger: UsageEventLogger = console,
): Promise<
  Array<Awaited<ReturnType<UsageReportingPersistence["recordAiUsage"]>>>
> {
  if (typeof repository?.recordAiUsage !== "function") return [];
  const recorded: Array<
    Awaited<ReturnType<UsageReportingPersistence["recordAiUsage"]>>
  > = [];
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
      } satisfies RecordAiUsageInput);
      if (row) recorded.push(row);
    } catch {
      logger.warn(
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
