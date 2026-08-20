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

const SUPPORTED_PROVIDERS = new Set(["openai", "gemini", "exa"]);

export class AiProvidersExhaustedError extends AggregateError {
  constructor(operation, errors) {
    super(errors, `No AI provider completed ${operation}`);
    this.name = "AiProvidersExhaustedError";
    this.code = "ai_providers_exhausted";
    this.operation = operation;
  }
}

export function getAiProviderOrder(env = process.env) {
  const order = (env.AI_PROVIDER_ORDER || "openai,gemini")
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
  { log = console } = {},
) {
  const available = providers.filter(Boolean);
  if (!available.length) {
    throw new Error(
      "No AI provider is configured; enable Exa or set an OpenAI/Gemini API key",
    );
  }

  const execute = async (operation, input) => {
    const errors = [];
    for (const provider of available) {
      if (typeof provider[operation] !== "function") {
        continue;
      }
      try {
        return await provider[operation](input);
      } catch (error) {
        errors.push(error);
        log.warn?.(
          JSON.stringify({
            event: "ai_provider_failed",
            operation,
            provider: provider.name,
            error_code: classifyProviderError(error),
          }),
        );
      }
    }
    throw new AiProvidersExhaustedError(operation, errors);
  };

  const executeOnce = async (operation, input) => {
    const provider = available.find(
      (candidate) => typeof candidate[operation] === "function",
    );
    if (!provider) {
      throw new AiProvidersExhaustedError(operation, []);
    }
    try {
      return await provider[operation](input);
    } catch (error) {
      log.warn?.(
        JSON.stringify({
          event: "ai_provider_failed",
          operation,
          provider: provider.name,
          error_code: classifyProviderError(error),
        }),
      );
      throw new AiProvidersExhaustedError(operation, [error]);
    }
  };

  return {
    names: available.map((provider) => provider.name),
    generateStructured: (input) => execute("generateStructured", input),
    generateStructuredOnce: (input) => executeOnce("generateStructured", input),
    searchNews: (input) => execute("searchNews", input),
    searchFeeds: (input) => execute("searchFeeds", input),
    searchFact: (input) => execute("searchFact", input),
  };
}

export function createAiProvider(env = process.env, { log = console } = {}) {
  const factories = {
    exa: () => createExaProvider(getExaProviderConfig(env)),
    openai: () => createOpenAiProvider(getOpenAiConfig(env)),
    gemini: () => createGeminiProvider(getGeminiProviderConfig(env)),
  };
  const providers = getAiProviderOrder(env).map((name) => factories[name]());
  return createFallbackAiProvider(providers, { log });
}
