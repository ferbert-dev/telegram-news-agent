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
 * No floor by default: every free model that supports structured outputs is a
 * candidate.
 *
 * A floor was a proxy for capability, and a bad one -- ranking by context
 * picked a 512k model built for notes, which answered and then failed the
 * grounding guard twice. Context is not capability, and excluding a small
 * model buys nothing now that the walk exists: a weak model sits at the end of
 * the list and is only ever reached if everything above it failed, which is
 * strictly better than falling through to a paid provider.
 *
 * OPEN_ROUTER_MIN_CONTEXT_TOKENS can still raise it, and
 * OPEN_ROUTER_MODEL orders the front of the list by hand.
 */
export const DEFAULT_MIN_CONTEXT_TOKENS = 0;

/**
 * How long any single free model gets before the next one is tried.
 *
 * Deliberately below the provider's own cascade deadline, so several models
 * can be attempted inside one provider turn instead of the first dead one
 * consuming the whole allowance.
 */
export const DEFAULT_PER_MODEL_TIMEOUT_MS = 35_000;

export const DEFAULT_OPEN_ROUTER_MODEL = "dots-studio/dots-3-note-preview:free";

export type OpenRouterConfig = {
  apiKey: string;
  /**
   * Preferred models, tried first and in order. Empty means "whatever the
   * catalogue offers"; discovery supplies the rest of the list either way.
   */
  preferredModels: readonly string[];
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
export async function discoverOpenRouterModels({
  baseUrl,
  minContextTokens,
  signal,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  minContextTokens: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { signal });
    if (!response.ok) return [DEFAULT_OPEN_ROUTER_MODEL];
    const body = (await response.json()) as {
      data?: Array<{
        id?: unknown;
        context_length?: unknown;
        pricing?: { prompt?: unknown; completion?: unknown };
        supported_parameters?: unknown;
        architecture?: {
          input_modalities?: unknown;
          output_modalities?: unknown;
        };
      }>;
    };
    const free = (body.data ?? []).filter((model) => {
      const prompt = Number(model.pricing?.prompt ?? NaN);
      const completion = Number(model.pricing?.completion ?? NaN);
      const context = Number(model.context_length ?? 0);
      const inputs = model.architecture?.input_modalities;
      const outputs = model.architecture?.output_modalities;
      // Text in, text ONLY out.
      //
      // Checked on the output rather than on the whole modality string: the
      // catalogue carries image and music generators, and one of them
      // (google/lyria-3-pro-preview, a music model) is free with a 1M window.
      // Nothing here would know what to do with an audio or image response.
      //
      // Deliberately NOT the strict "text->text" modality, which would also
      // drop openrouter/free and dots-3 -- both accept an image as INPUT and
      // answer in text. We only ever send text, so what a model is willing to
      // read costs us nothing; what it answers with is the part that has to
      // be text.
      const textIn = Array.isArray(inputs) && inputs.includes("text");
      const textOnlyOut =
        Array.isArray(outputs)
        && outputs.length === 1
        && outputs[0] === "text";
      return (
        typeof model.id === "string"
        && model.id.length > 0
        && prompt === 0
        && completion === 0
        && context >= minContextTokens
        && textIn
        && textOnlyOut
        // The other filter that is not negotiable: every call this adapter
        // serves is generateStructured, so a model that cannot honour
        // response_format is unusable here at any size.
        && Array.isArray(model.supported_parameters)
        && model.supported_parameters.includes("structured_outputs")
      );
    });
    if (!free.length) return [DEFAULT_OPEN_ROUTER_MODEL];
    free.sort(
      (left, right) =>
        Number(right.context_length ?? 0) - Number(left.context_length ?? 0),
    );
    // The whole ranked list, not just the winner. Free models are queued
    // behind paid traffic and any one of them can simply not answer; calling
    // the next one costs nothing, which is the entire reason to prefer a free
    // provider in the first place.
    return free.map((model) => model.id as string);
  } catch {
    return [DEFAULT_OPEN_ROUTER_MODEL];
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
    // A comma-separated preference list, tried before anything discovered.
    // Pinning a single model used to skip discovery entirely, which also
    // switched off the walk -- so a rate-limited favourite had nowhere to go
    // but a paid provider. Preferences now lead the list rather than replace
    // it.
    preferredModels: ((env.OPEN_ROUTER_MODEL ?? env.OPENROUTER_MODEL) ?? "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
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
    discover = discoverOpenRouterModels,
    perModelTimeoutMs = DEFAULT_PER_MODEL_TIMEOUT_MS,
  }: {
    client: ChatCompletionsClient;
    discover?: typeof discoverOpenRouterModels;
    perModelTimeoutMs?: number;
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
  let resolvedModels: Promise<string[]> | null = null;
  // Once a model has actually answered, it goes to the front for the rest of
  // the process. Otherwise every call would re-pay the timeout of whichever
  // dead model happens to sort first.
  let provenModel: string | null = null;

  const candidatesFor = async (signal?: AbortSignal): Promise<string[]> => {
    resolvedModels ??= discover({
      baseUrl: config.baseUrl,
      minContextTokens: config.minContextTokens,
      signal,
    });
    // Preferences first, then everything the catalogue offers, then the pinned
    // fallback -- deduplicated, order preserved.
    //
    // Discovery runs even when preferences are set. A preferred model that is
    // rate-limited must have somewhere free to go; without the discovered tail
    // its only fallback is a paid provider, which is what this provider exists
    // to avoid.
    const ordered = [
      ...(provenModel ? [provenModel] : []),
      ...config.preferredModels,
      ...(await resolvedModels),
      DEFAULT_OPEN_ROUTER_MODEL,
    ];
    return [...new Set(ordered)];
  };

  return {
    name: "openrouter",
    // The first preference when there is one, otherwise null: the model is not
    // known until the walk finds one that answers. The id that actually ran is
    // reported on every result, which is what the usage ledger records.
    model: config.preferredModels[0] ?? null,

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

      const callModel = async (
        model: string,
        attemptSignal: AbortSignal,
      ): Promise<AiProviderResult> => {
        const response = await client.chat.completions.create(
          {
            model,
            messages: [
              { role: "system", content: systemInstruction },
              { role: "user", content: JSON.stringify(payload) },
            ],
            response_format: zodResponseFormat(zodSchema, schemaName),
            // Without this, OpenRouter may route to a provider that does not
            // support response_format and, by its own documented default,
            // "will still receive the request but ignore unsupported
            // parameters" -- returning prose that fails validation below,
            // after the call has already been billed. require_parameters
            // excludes those providers from routing, so a model whose serving
            // providers cannot do structured output fails fast rather than
            // failing expensively.
            provider: { require_parameters: true },
          },
          { signal: attemptSignal },
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
        // routes to whichever provider serves the model, and enforcement
        // varies between them. The zod schema is the same one every other
        // provider is held to, so a loosely-shaped response fails here instead
        // of leaking an unvalidated object into the pipeline.
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
      };

      // Walk the free models rather than falling straight through to a paid
      // provider.
      //
      // A free endpoint is queued behind paid traffic and can simply not
      // answer -- which is exactly what happened on the integration stage:
      // four attempts, every one of them timing out at the cascade's deadline,
      // after which the run fell through to a rate-limited OpenAI and a
      // rate-limited Gemini and failed outright. Calling the next free model
      // costs nothing, which is the entire reason to prefer a free provider.
      const candidates = await candidatesFor(signal);
      let lastError: unknown = new Error(
        "OpenRouter had no candidate model to call",
      );

      for (const model of candidates) {
        // Each model gets its own budget, so one that never answers cannot eat
        // the whole allowance and starve the models after it. The caller's
        // signal still wins: an outer abort stops the walk immediately rather
        // than working through the rest of the list.
        const attemptSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(perModelTimeoutMs)])
          : AbortSignal.timeout(perModelTimeoutMs);
        try {
          const attempt = await callModel(model, attemptSignal);
          provenModel = model;
          return attempt;
        } catch (error) {
          if (signal?.aborted) throw error;
          // Stop preferring a model that just failed. Left set, it would be
          // retried first on every subsequent call, re-paying its timeout or
          // its rate limit before the walk could reach anything that works.
          if (provenModel === model) provenModel = null;
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}
