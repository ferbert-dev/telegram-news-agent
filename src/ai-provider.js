import {
  createGeminiProvider,
  getGeminiProviderConfig,
} from "./gemini-provider.js";
import {
  createOpenAiProvider,
  getOpenAiConfig,
} from "./openai-provider.js";
import {
  createExaProvider,
  getExaProviderConfig,
} from "./exa-provider.js";
import {
  classifySafeProviderError,
  isTransientProviderError,
  newAttemptId,
  safeAttemptDiagnostics,
} from "./ai-provider-attempts.js";

const SUPPORTED_PROVIDERS = new Set(["openai", "gemini", "exa"]);

export class AiProvidersExhaustedError extends AggregateError {
  constructor(operation, errors, traceId = newAttemptId()) {
    super(errors, `No AI provider completed ${operation}`);
    this.name = "AiProvidersExhaustedError";
    this.code = "ai_providers_exhausted";
    this.operation = operation;
    this.traceId = traceId;
  }
}

export function getAiProviderOrder(env = process.env) {
  const configuredOrder = env.AI_PROVIDER_ORDER?.trim();
  const defaultOrder = getExaProviderConfig(env)
    ? "exa,openai,gemini"
    : "openai,gemini";
  const order = (configuredOrder || defaultOrder)
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(order)];
  const unsupported = unique.filter((name) => !SUPPORTED_PROVIDERS.has(name));
  if (unsupported.length) {
    throw new Error(`Unsupported AI provider: ${unsupported.join(", ")}`);
  }
  if (!unique.length) {
    throw new Error("AI_PROVIDER_ORDER must contain at least one provider");
  }
  return unique;
}

export function classifyProviderError(error) {
  const safeCode = classifySafeProviderError(error);
  if (safeCode !== "provider_failed") return safeCode;
  const status = Number(error?.status ?? error?.statusCode ?? error?.code);
  if (status === 401 || status === 403) {
    return "authentication_failed";
  }
  if (status === 402) {
    return "quota_exhausted";
  }
  if (status === 408 || status === 429) {
    return status === 429 ? "rate_limited" : "timeout";
  }
  if (status >= 500) {
    return "upstream_unavailable";
  }
  if (error?.name === "ZodError" || error instanceof SyntaxError) {
    return "invalid_response";
  }
  return "provider_failed";
}

export function createFallbackAiProvider(
  providers,
  { log = console, attemptRepository = null, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const available = providers.filter(Boolean);
  if (!available.length) {
    throw new Error(
      "No AI provider is configured; enable Exa or set an OpenAI/Gemini API key",
    );
  }

  const writeAttempt = async (method, input) => {
    if (!attemptRepository?.[method]) return;
    try {
      await attemptRepository[method](input);
    } catch {
      log.warn?.(JSON.stringify({ event: "ai_provider_attempt_telemetry_failed", operation: input.operation ?? null }));
    }
  };

  const runAttempt = async ({ operation, input, provider, correlationId, attemptNumber }) => {
    const id = newAttemptId();
    const started = now();
    const semanticOperation = input?.usageOperation ?? operation;
    await writeAttempt("startAiProviderAttempt", {
      id, correlationId, operation: semanticOperation, provider: provider.name,
      model: provider.model ?? null, attemptNumber, startedAt: started.toISOString(),
    });
    try {
      const result = await provider[operation](input);
      await writeAttempt("completeAiProviderAttempt", {
        id, status: "succeeded", completedAt: now().toISOString(),
        latencyMs: Math.max(0, now().valueOf() - started.valueOf()),
        ...safeAttemptDiagnostics(null, result),
      });
      return result;
    } catch (error) {
      error.traceId ??= correlationId;
      error.providerDiagnostics = {
        ...error.providerDiagnostics,
        provider: provider.name,
      };
      await writeAttempt("completeAiProviderAttempt", {
        id, status: "failed", completedAt: now().toISOString(),
        latencyMs: Math.max(0, now().valueOf() - started.valueOf()),
        ...safeAttemptDiagnostics(error),
      });
      throw error;
    }
  };

  const execute = async (operation, input) => {
    const errors = [];
    const correlationId = input?.traceId ?? newAttemptId();
    let attemptNumber = 0;
    for (const provider of available) {
      if (typeof provider[operation] !== "function") {
        continue;
      }
      try {
        return await runAttempt({ operation, input, provider, correlationId, attemptNumber: ++attemptNumber });
      } catch (error) {
        errors.push(error);
        const errorCode = classifyProviderError(error);
        log.warn?.(
          JSON.stringify({
            event: "ai_provider_failed",
            operation,
            provider: provider.name,
            error_code: errorCode,
          }),
        );
        if (provider.name === "exa" && errorCode === "quota_exhausted") {
          throw new AiProvidersExhaustedError(input?.usageOperation ?? operation, errors, correlationId);
        }
        if (isTransientProviderError(error)) {
          try {
            await sleep(250);
            return await runAttempt({ operation, input, provider, correlationId, attemptNumber: ++attemptNumber });
          } catch (retryError) {
            errors.push(retryError);
            log.warn?.(JSON.stringify({ event: "ai_provider_failed", operation, provider: provider.name, error_code: classifyProviderError(retryError) }));
          }
        }
      }
    }
    throw new AiProvidersExhaustedError(input?.usageOperation ?? operation, errors, correlationId);
  };

  const executeOnce = async (operation, input) => {
    const provider = available.find(
      (candidate) => typeof candidate[operation] === "function",
    );
    if (!provider) {
      throw new AiProvidersExhaustedError(operation, []);
    }
    try {
      return await runAttempt({ operation, input, provider, correlationId: input?.traceId ?? newAttemptId(), attemptNumber: 1 });
    } catch (error) {
      log.warn?.(
        JSON.stringify({
          event: "ai_provider_failed",
          operation,
          provider: provider.name,
          error_code: classifyProviderError(error),
        }),
      );
      throw new AiProvidersExhaustedError(operation, [error], error.traceId);
    }
  };

  const executeFactSearch = async (input) => {
    const exa = available.find(
      (candidate) =>
        candidate.name === "exa" && typeof candidate.searchFact === "function",
    );
    if (!exa) return execute("searchFact", input);
    const correlationId = input?.traceId ?? newAttemptId();
    try {
      return await runAttempt({ operation: "searchFact", input, provider: exa, correlationId, attemptNumber: 1 });
    } catch (error) {
      log.warn?.(
        JSON.stringify({
          event: "ai_provider_failed",
          operation: "searchFact",
          provider: exa.name,
          error_code: classifyProviderError(error),
        }),
      );
      if (isTransientProviderError(error)) {
        try {
          await sleep(250);
          return await runAttempt({ operation: "searchFact", input, provider: exa, correlationId, attemptNumber: 2 });
        } catch (retryError) {
          log.warn?.(JSON.stringify({ event: "ai_provider_failed", operation: "searchFact", provider: exa.name, error_code: classifyProviderError(retryError) }));
          throw new AiProvidersExhaustedError("searchFact", [error, retryError], correlationId);
        }
      }
      throw new AiProvidersExhaustedError("searchFact", [error], correlationId);
    }
  };

  const testExaConnection = async () => {
    const exa = available.find(
      (candidate) =>
        candidate.name === "exa" &&
        typeof candidate.testConnection === "function",
    );
    if (!exa) {
      throw new AiProvidersExhaustedError("testExaConnection", []);
    }
    return exa.testConnection();
  };

  return {
    names: available.map((provider) => provider.name),
    generateStructured: (input) => execute("generateStructured", input),
    generateStructuredOnce: (input) => executeOnce("generateStructured", input),
    searchNews: (input) => execute("searchNews", input),
    searchFeeds: (input) => execute("searchFeeds", input),
    searchFact: executeFactSearch,
    testExaConnection,
  };
}

export function createAiProvider(env = process.env, { log = console, attemptRepository = null } = {}) {
  const factories = {
    exa: () => createExaProvider(getExaProviderConfig(env)),
    openai: () => createOpenAiProvider(getOpenAiConfig(env)),
    gemini: () => createGeminiProvider(getGeminiProviderConfig(env)),
  };
  const providers = getAiProviderOrder(env).map((name) => factories[name]());
  return createFallbackAiProvider(providers, { log, attemptRepository });
}
