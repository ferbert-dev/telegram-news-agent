import { zodResponseFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";

import { providerDiagnosticError } from "../../telemetry/ai-provider-attempts.adapters.js";
import { openRouterUsageEvent } from "../../telemetry/ai-usage.adapters.js";
import type { AiProviderPort, AiProviderResult } from "../ai-provider.contracts.js";

export const OPEN_ROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * A free model by default, and the largest-context one that can actually do
 * the job.
 *
 * A paid default would be indefensible -- OpenRouter fronts hundreds of models
 * at different prices, and picking one would bill for a choice nobody made. A
 * `:free` model cannot, which is what makes any default acceptable here.
 *
 * The binding constraint is structured outputs, not context. Every call this
 * adapter serves goes through generateStructured, so a model that cannot honour
 * response_format is unusable here regardless of how large its window is --
 * with require_parameters set below, such a request does not route at all.
 *
 * Checked against OpenRouter's public model list rather than assumed. Of 22
 * free models, 7 offer a context window of 1M or more and NONE of them support
 * structured outputs; only 5 free models support structured outputs at all:
 *
 *   dots-studio/dots-3-note-preview:free        ctx 512k   <- chosen
 *   nvidia/nemotron-3-super-120b-a12b:free      ctx 262k
 *   z-ai/glm-5.2:free                           ctx 256k
 *   openrouter/free                             ctx 200k
 *   liquid/lfm-2.5-2.6b:free                    ctx  65k
 *
 * 512k is far beyond what this pipeline asks for anyway: the largest single
 * call is curation at roughly 12k tokens, and a classification batch is under
 * 10k. Context was never the limit here.
 *
 * Regenerate the list with:
 *   curl -s https://openrouter.ai/api/v1/models | jq -r '.data[]
 *     | select(.pricing.prompt == "0" and .pricing.completion == "0")
 *     | select(.supported_parameters | index("structured_outputs"))
 *     | "\(.id)  ctx=\(.context_length)"'
 *
 * If this id is retired the call fails loudly -- require_parameters means an
 * unroutable request errors rather than quietly returning prose -- so a stale
 * default costs a clear error, never a silent wrong answer or a bill. Override
 * with OPEN_ROUTER_MODEL; nvidia/nemotron-3-super-120b-a12b:free is the
 * strongest general-purpose alternative if output quality disappoints.
 */
/**
 * The floor for automatic selection. Well above anything this pipeline sends --
 * its largest single call is curation at roughly 12k tokens -- so it is a
 * quality filter rather than a capacity one: a model with a small window is
 * usually a small model.
 */
export const DEFAULT_MIN_CONTEXT_TOKENS = 200_000;

export const DEFAULT_OPEN_ROUTER_MODEL = "dots-studio/dots-3-note-preview:free";

export type OpenRouterConfig = {
  apiKey: string;
  /** null means "discover one at first use"; a string is an explicit override. */
  model: string | null;
  baseUrl: string;
  minContextTokens: number;
};

/**
 * Pick a model from OpenRouter's live catalogue instead of trusting a constant.
 *
 * A hardcoded id is wrong the day a free model is retired, and free models are
 * retired often. This asks OpenRouter what exists right now and takes the
 * largest-context free model that can actually do the job.
 *
 * Three filters, and the middle one is not optional: every call this adapter
 * serves goes through generateStructured, so a model that does not declare
 * `structured_outputs` is unusable here no matter how large its window is --
 * with require_parameters set, such a request does not route at all.
 *
 * The endpoint is public and unauthenticated, so this leaks no credential. It
 * is called at most once per process, and any failure -- network, timeout,
 * empty result -- falls back to the pinned default rather than leaving the
 * provider unusable.
 */
export async function discoverOpenRouterModel({
  baseUrl,
  minContextTokens,
  signal,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  minContextTokens: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { signal });
    if (!response.ok) return DEFAULT_OPEN_ROUTER_MODEL;
    const body = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        context_length?: unknown;
        pricing?: { prompt?: unknown; completion?: unknown };
        supported_parameters?: unknown;
      }>;
    };
    const free = (body.data ?? []).filter((model) => {
      const prompt = Number(model.pricing?.prompt ?? NaN);
      const completion = Number(model.pricing?.completion ?? NaN);
      const context = Number(model.context_length ?? 0);
      return (
        typeof model.id === "string"
        && model.id.length > 0
        && prompt === 0
        && completion === 0
        && context >= minContextTokens
        && Array.isArray(model.supported_parameters)
        && model.supported_parameters.includes("structured_outputs")
      );
    });
    if (!free.length) return DEFAULT_OPEN_ROUTER_MODEL;
    free.sort(
      (left, right) =>
        Number(right.context_length ?? 0) - Number(left.context_length ?? 0),
    );
    return free[0].id as string;
  } catch {
    return DEFAULT_OPEN_ROUTER_MODEL;
  }
}

/**
 * OpenRouter exists only in the typed runtime, on purpose.
 *
 * The legacy JS providers under src/*-provider.js are what the migration is
 * moving away from; adding a new one there would grow the surface that has to
 * be ported. Production runs the legacy entrypoint and has no OpenRouter key,
 * so it neither needs nor sees this provider.
 *
 * It is also a separate adapter rather than a base-URL override on the OpenAI
 * one: OpenRouter is OpenAI-compatible at CHAT COMPLETIONS only, and
 * openai-provider.js is built on the Responses API (`responses.parse`), which
 * OpenRouter does not implement. Pointing that adapter here would 404 on every
 * call.
 */
export function getOpenRouterConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterConfig | null {
  // The name matches the one already present in the encrypted integration
  // environment. The conventional spelling is accepted too, so an environment
  // that uses it later is not silently ignored.
  const apiKey =
    env.OPEN_ROUTER_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;

  const minContext = Number(env.OPEN_ROUTER_MIN_CONTEXT_TOKENS ?? "");

  return {
    apiKey,
    // An explicit model always wins and skips discovery entirely -- no network
    // call, no surprise about which model ran.
    model: (env.OPEN_ROUTER_MODEL ?? env.OPENROUTER_MODEL)?.trim() || null,
    baseUrl: env.OPEN_ROUTER_BASE_URL?.trim() || OPEN_ROUTER_BASE_URL,
    minContextTokens:
      Number.isSafeInteger(minContext) && minContext > 0
        ? minContext
        : DEFAULT_MIN_CONTEXT_TOKENS,
  };
}

type ChatCompletionsClient = {
  chat: {
    completions: {
      create: (
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => Promise<{
        id?: string | null;
        usage?: unknown;
        choices?: Array<{
          message?: { content?: string | null; refusal?: string | null };
          finish_reason?: string | null;
        }>;
      }>;
    };
  };
};

export function createOpenRouterProvider(
  config: OpenRouterConfig | null,
  {
    client,
    discover = discoverOpenRouterModel,
  }: {
    client: ChatCompletionsClient;
    discover?: typeof discoverOpenRouterModel;
  },
): AiProviderPort | null {
  if (!config) return null;

  // Resolved once per process, on first use rather than at registration.
  //
  // Discovery is a network call and configure() is synchronous, so it cannot
  // happen there -- and it must not happen per request either, which would put
  // an extra round trip in front of every call. The promise is memoised, so
  // concurrent first calls share one lookup, and a failed lookup still resolves
  // (to the pinned default) rather than rejecting every future call.
  let resolvedModel: Promise<string> | null = null;
  const modelFor = (signal?: AbortSignal): Promise<string> => {
    if (config.model) return Promise.resolve(config.model);
    resolvedModel ??= discover({
      baseUrl: config.baseUrl,
      minContextTokens: config.minContextTokens,
      signal,
    });
    return resolvedModel;
  };

  return {
    name: "openrouter",
    // Null until first use when discovery is in play; the resolved id is
    // reported on every result, which is what the usage ledger records.
    model: config.model,

    async generateStructured(input: Record<string, unknown>): Promise<AiProviderResult> {
      const {
        systemInstruction,
        input: payload,
        zodSchema,
        schemaName,
        usageOperation = "structured_generation",
        signal,
      } = input as {
        systemInstruction: string;
        input: unknown;
        zodSchema: ZodType;
        schemaName: string;
        usageOperation?: string;
        signal?: AbortSignal;
      };

      const model = await modelFor(signal);
      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: JSON.stringify(payload) },
          ],
          response_format: zodResponseFormat(zodSchema, schemaName),
          // Without this, OpenRouter may route to a provider that does not
          // support response_format and, by its own documented default, "will
          // still receive the request but ignore unsupported parameters" --
          // returning prose that fails validation below, after the call has
          // already been billed. require_parameters excludes those providers
          // from routing, so a model whose serving providers cannot do
          // structured output fails fast rather than expensively.
          provider: { require_parameters: true },
        },
        signal ? { signal } : undefined,
      );

      const usage = openRouterUsageEvent(response, {
        model,
        operation: usageOperation,
      });
      const choice = response?.choices?.[0];
      const content = choice?.message?.content;

      if (choice?.message?.refusal) {
        throw providerDiagnosticError("structured_output_missing", {
          providerResponseId: response?.id ?? null,
          responseStatus: choice?.finish_reason ?? null,
          refusal: true,
          usage,
        });
      }
      if (typeof content !== "string" || content.trim() === "") {
        throw providerDiagnosticError("structured_output_missing", {
          providerResponseId: response?.id ?? null,
          responseStatus: choice?.finish_reason ?? null,
          incompleteReason: choice?.finish_reason ?? null,
          refusal: false,
          usage,
        });
      }

      // Parsed and validated here rather than trusted.
      //
      // Strict json_schema mode is a request, not a guarantee: OpenRouter
      // routes to whichever provider serves the model, and enforcement varies
      // between them. The zod schema is the same one every other provider is
      // held to, so a loosely-shaped response fails here instead of leaking an
      // unvalidated object into the pipeline.
      let value: unknown;
      try {
        value = zodSchema.parse(JSON.parse(content));
      } catch (cause) {
        throw providerDiagnosticError(
          "structured_output_missing",
          {
            providerResponseId: response?.id ?? null,
            responseStatus: choice?.finish_reason ?? null,
            incompleteReason: "schema_validation_failed",
            refusal: false,
            usage,
          },
          cause as Error,
        );
      }

      return {
        value,
        provider: "openrouter",
        model,
        usageEvents: [usage].filter(Boolean),
      };
    },
  };
}
