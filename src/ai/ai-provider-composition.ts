import {
  isTransientProviderError,
  newAttemptId,
} from "../telemetry/ai-provider-attempts.adapters.js";
import {
  persistCompleteAiProviderAttempt,
  persistStartAiProviderAttempt,
  safeAttemptDiagnostics,
} from "../telemetry/ai-provider-attempts.adapters.js";
import { getExaProviderConfig } from "../exa-provider.js";

import type {
  AiProviderAttemptWriter,
  AiProviderLogger,
  AiProviderOperation,
  AiProviderPort,
  AiProviderResult,
} from "./ai-provider.contracts.js";

const SUPPORTED_PROVIDERS = new Set(["openai", "gemini", "exa"]);

export class AiProvidersExhaustedError extends AggregateError {
  public readonly code = "ai_providers_exhausted";

  constructor(
    public readonly operation: string,
    errors: unknown[],
    public readonly traceId = newAttemptId(),
  ) {
    super(errors, `No AI provider completed ${operation}`);
    this.name = "AiProvidersExhaustedError";
  }
}

export function getAiProviderOrder(env: NodeJS.ProcessEnv = process.env): string[] {
  const configuredOrder = env.AI_PROVIDER_ORDER?.trim();
  const defaultOrder = getExaProviderConfig(env)
    ? "exa,openai,gemini"
    : "openai,gemini";
  const unique = [...new Set((configuredOrder || defaultOrder).split(",")
    .map((name) => name.trim().toLowerCase()).filter(Boolean))];
  const unsupported = unique.filter((name) => !SUPPORTED_PROVIDERS.has(name));
  if (unsupported.length) throw new Error(`Unsupported AI provider: ${unsupported.join(", ")}`);
  if (!unique.length) throw new Error("AI_PROVIDER_ORDER must contain at least one provider");
  return unique;
}

export function classifyProviderError(error: unknown): string {
  return safeAttemptDiagnostics(error).errorCode ?? "provider_failed";
}

export type FallbackAiProvider = {
  names: Array<AiProviderPort["name"]>;
  generateStructured: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  generateStructuredOnce: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  searchNews: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  searchFeeds: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  searchFact: (input: Record<string, unknown>) => Promise<AiProviderResult>;
  testExaConnection: () => Promise<AiProviderResult>;
};

export function createFallbackAiProvider(
  providers: Array<AiProviderPort | null | undefined>,
  {
    log = console,
    attemptRepository,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    log?: AiProviderLogger;
    attemptRepository?: AiProviderAttemptWriter | null;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): FallbackAiProvider {
  const available = providers.filter((provider): provider is AiProviderPort => Boolean(provider));
  if (!available.length) throw new Error("No AI provider is configured; enable Exa or set an OpenAI/Gemini API key");

  const runAttempt = async (
    operation: AiProviderOperation,
    input: Record<string, unknown>,
    provider: AiProviderPort,
    correlationId: string,
    attemptNumber: number,
  ) => {
    const id = newAttemptId();
    const started = now();
    const semanticOperation = typeof input.usageOperation === "string" ? input.usageOperation : operation;
    await persistStartAiProviderAttempt(attemptRepository, {
      id, correlationId, operation: semanticOperation, provider: provider.name,
      model: provider.model ?? null, attemptNumber, startedAt: started.toISOString(),
    }, log as Required<AiProviderLogger>);
    try {
      const method = provider[operation];
      if (!method) throw new Error(`Provider ${provider.name} does not support ${operation}`);
      const result = await method(input);
      await persistCompleteAiProviderAttempt(attemptRepository, {
        id, status: "succeeded", completedAt: now().toISOString(),
        latencyMs: Math.max(0, now().valueOf() - started.valueOf()), result,
      }, log as Required<AiProviderLogger>);
      return result;
    } catch (error) {
      const mutable = error as { traceId?: string; providerDiagnostics?: Record<string, unknown> };
      mutable.traceId ??= correlationId;
      mutable.providerDiagnostics = { ...mutable.providerDiagnostics, provider: provider.name };
      await persistCompleteAiProviderAttempt(attemptRepository, {
        id, status: "failed", completedAt: now().toISOString(),
        latencyMs: Math.max(0, now().valueOf() - started.valueOf()), error,
      }, log as Required<AiProviderLogger>);
      throw error;
    }
  };

  const warn = (operation: string, provider: AiProviderPort, error: unknown) => log.warn?.(JSON.stringify({
    event: "ai_provider_failed", operation, provider: provider.name, error_code: classifyProviderError(error),
  }));

  const execute = async (operation: AiProviderOperation, input: Record<string, unknown>) => {
    const errors: unknown[] = [];
    const correlationId = typeof input.traceId === "string" ? input.traceId : newAttemptId();
    let attemptNumber = 0;
    for (const provider of available) {
      if (!provider[operation]) continue;
      try {
        return await runAttempt(operation, input, provider, correlationId, ++attemptNumber);
      } catch (error) {
        errors.push(error); warn(operation, provider, error);
        if (provider.name === "exa" && classifyProviderError(error) === "quota_exhausted") {
          throw new AiProvidersExhaustedError(typeof input.usageOperation === "string" ? input.usageOperation : operation, errors, correlationId);
        }
        if (isTransientProviderError(error)) {
          try {
            await sleep(250);
            return await runAttempt(operation, input, provider, correlationId, ++attemptNumber);
          } catch (retryError) {
            errors.push(retryError); warn(operation, provider, retryError);
          }
        }
      }
    }
    throw new AiProvidersExhaustedError(typeof input.usageOperation === "string" ? input.usageOperation : operation, errors, correlationId);
  };

  const executeOnce = async (operation: AiProviderOperation, input: Record<string, unknown>) => {
    const provider = available.find((candidate) => Boolean(candidate[operation]));
    if (!provider) throw new AiProvidersExhaustedError(operation, []);
    const correlationId = typeof input.traceId === "string" ? input.traceId : newAttemptId();
    try {
      return await runAttempt(operation, input, provider, correlationId, 1);
    } catch (error) {
      warn(operation, provider, error);
      throw new AiProvidersExhaustedError(operation, [error], (error as { traceId?: string }).traceId ?? correlationId);
    }
  };

  const executeFactSearch = async (input: Record<string, unknown>) => {
    const exa = available.find((candidate) => candidate.name === "exa" && candidate.searchFact);
    if (!exa) return execute("searchFact", input);
    const correlationId = typeof input.traceId === "string" ? input.traceId : newAttemptId();
    try {
      return await runAttempt("searchFact", input, exa, correlationId, 1);
    } catch (error) {
      warn("searchFact", exa, error);
      if (!isTransientProviderError(error)) throw new AiProvidersExhaustedError("searchFact", [error], correlationId);
      try {
        await sleep(250);
        return await runAttempt("searchFact", input, exa, correlationId, 2);
      } catch (retryError) {
        warn("searchFact", exa, retryError);
        throw new AiProvidersExhaustedError("searchFact", [error, retryError], correlationId);
      }
    }
  };

  return {
    names: available.map((provider) => provider.name),
    generateStructured: (input) => execute("generateStructured", input),
    generateStructuredOnce: (input) => executeOnce("generateStructured", input),
    searchNews: (input) => execute("searchNews", input),
    searchFeeds: (input) => execute("searchFeeds", input),
    searchFact: executeFactSearch,
    async testExaConnection() {
      const exa = available.find((provider) => provider.name === "exa" && provider.testConnection);
      if (!exa?.testConnection) throw new AiProvidersExhaustedError("testExaConnection", []);
      return exa.testConnection();
    },
  };
}
