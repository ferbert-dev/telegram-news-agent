import {
  isTransientProviderError,
  newAttemptId,
} from "../telemetry/ai-provider-attempts.adapters.js";
import {
  persistCompleteAiProviderAttempt,
  persistStartAiProviderAttempt,
  safeAttemptDiagnostics,
} from "../telemetry/ai-provider-attempts.adapters.js";
import { BUILTIN_PROVIDER_DESCRIPTORS } from "./providers/index.js";
import { getDefaultProviderOrder, listProviderIds, traitsOf } from "./providers/provider-registry.js";
import type { AiProviderDescriptor } from "./providers/provider-descriptor.contracts.js";

import type {
  AiProviderAttemptWriter,
  AiProviderLogger,
  AiProviderOperation,
  AiProviderPort,
  AiProviderResult,
} from "./ai-provider.contracts.js";

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

export function getAiProviderOrder(
  env: NodeJS.ProcessEnv = process.env,
  descriptors: readonly AiProviderDescriptor[] = BUILTIN_PROVIDER_DESCRIPTORS,
): string[] {
  const supportedProviders = new Set(listProviderIds(descriptors));
  const configuredOrder = env.AI_PROVIDER_ORDER?.trim();
  const defaultOrder = getDefaultProviderOrder(env, descriptors).join(",");
  const unique = [...new Set((configuredOrder || defaultOrder).split(",")
    .map((name) => name.trim().toLowerCase()).filter(Boolean))];
  const unsupported = unique.filter((name) => !supportedProviders.has(name));
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
  testConnection: (providerId: string) => Promise<AiProviderResult>;
  testExaConnection: () => Promise<AiProviderResult>;
};

const FALLBACK_PROVIDER_DEADLINE_MS = 30_000;
const FALLBACK_PROVIDER_ATTEMPTS = 3;

/**
 * How many consecutive throttled calls make a provider unusable for a while.
 *
 * Counts consecutive throttled CALLS, not attempts, so a single call's retries
 * cannot open it. Per-call retry was already bounded at
 * FALLBACK_PROVIDER_ATTEMPTS; nothing was bounded ACROSS calls, and that is the gap that hurt: a research run classifies
 * one candidate at a time, so a provider returning 429 to everything was asked
 * again for every remaining candidate. Measured on a real run: 344 calls x 3
 * attempts = 1005 requests at 2.8/sec for six minutes, 986 of them 429s, and it
 * only stopped because the process was killed.
 */
const THROTTLE_BREAKER_THRESHOLD = 5;

/**
 * How long a throttled provider is skipped before being tried again. Long
 * enough that a rate limit has a chance to clear, short enough that a brief
 * burst does not disable the provider for the life of the process.
 */
const THROTTLE_BREAKER_COOLDOWN_MS = 60_000;

/** Error codes that mean "you are asking too often", as opposed to "this call failed". */
const THROTTLE_ERROR_CODES = new Set(["rate_limited", "quota_exhausted"]);

/**
 * Codes that mean the credential itself is rejected.
 *
 * Kept separate from throttling because they behave differently: a rate limit
 * clears on its own, a rejected key does not. The provider configuration is
 * read once at boot, so nothing can repair this without a restart -- retrying
 * is guaranteed waste, and it is paid on every call.
 *
 * Measured on the integration stage: an invalid OpenAI key produced 1,967
 * rejections, three per call, delaying every one by roughly 680ms before the
 * fallback could even be tried. It never opened the breaker, because 401 is
 * not a throttle.
 */
const CREDENTIAL_ERROR_CODES = new Set(["authentication_failed"]);

/**
 * Two, not five. A 401 is deterministic -- unlike a rate limit, which depends
 * on what else is in flight -- so a second identical rejection is already
 * conclusive. One is left as tolerance for a transient auth blip at a
 * provider's edge.
 */
const CREDENTIAL_BREAKER_THRESHOLD = 2;

/**
 * Long, because there is nothing to wait for: only a restart can change the
 * key. Not permanent, so a provider whose auth was briefly broken at its own
 * end recovers without one.
 */
const CREDENTIAL_BREAKER_COOLDOWN_MS = 15 * 60_000;
const FALLBACK_RETRY_BASE_DELAY_MS = 250;
const FALLBACK_RETRY_MAX_DELAY_MS = 2_000;
const FALLBACK_RETRY_JITTER_RATIO = 0.3;

function timeoutError() {
  const error = new Error("AI provider operation deadline exceeded") as Error & { code: string };
  error.name = "TimeoutError";
  error.code = "timeout";
  return error;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(
    value
    && typeof value === "object"
    && "aborted" in value
    && "addEventListener" in value
    && "removeEventListener" in value,
  );
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("AI provider operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) throw abortReason(signal);
}

function retryDelayMs(attempt: number, random: () => number): number {
  const baseDelay = Math.min(
    FALLBACK_RETRY_MAX_DELAY_MS,
    FALLBACK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
  );
  const jitterSpan = baseDelay * FALLBACK_RETRY_JITTER_RATIO;
  return Math.floor(Math.max(1, baseDelay - jitterSpan + 2 * jitterSpan * random()));
}

export function createFallbackAiProvider(
  providers: Array<AiProviderPort | null | undefined>,
  {
    log = console,
    attemptRepository,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    providerDeadlineMs = FALLBACK_PROVIDER_DEADLINE_MS,
    random = Math.random,
    setTimeoutImpl = (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeoutImpl = (timeoutId: unknown) => clearTimeout(timeoutId as ReturnType<typeof setTimeout>),
    descriptors = BUILTIN_PROVIDER_DESCRIPTORS,
  }: {
    log?: AiProviderLogger;
    attemptRepository?: AiProviderAttemptWriter | null;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    providerDeadlineMs?: number;
    random?: () => number;
    setTimeoutImpl?: (callback: () => void, delayMs: number) => unknown;
    clearTimeoutImpl?: (timeoutId: unknown) => void;
    /** Traits (haltsCascadeOnQuotaExhaustion, exclusiveOperations, ...) are
     *  resolved against this set. Defaults to the built-in registry; pass a
     *  superset here when composing providers outside it. */
    descriptors?: readonly AiProviderDescriptor[];
  } = {},
): FallbackAiProvider {
  const available = providers.filter((provider): provider is AiProviderPort => Boolean(provider));
  if (!available.length) throw new Error("No AI provider is configured; enable Exa or set an OpenAI/Gemini API key");

  /** Consecutive throttled calls, and when the provider may be tried again. */
  const throttleState = new Map<
    string,
    { consecutive: number; consecutiveCredential: number; openUntilMs: number }
  >();

  const throttleFor = (name: string) => {
    let state = throttleState.get(name);
    if (!state) {
      state = { consecutive: 0, consecutiveCredential: 0, openUntilMs: 0 };
      throttleState.set(name, state);
    }
    return state;
  };

  const isThrottleOpen = (name: string) => now().getTime() < throttleFor(name).openUntilMs;

  const recordThrottleOutcome = (name: string, errorCode: string | null) => {
    const state = throttleFor(name);
    if (errorCode === null) {
      // A success clears the streak. A provider that answers is not throttling.
      state.consecutive = 0;
      state.consecutiveCredential = 0;
      state.openUntilMs = 0;
      return;
    }
    if (CREDENTIAL_ERROR_CODES.has(errorCode)) {
      // Counted on its own streak: mixing it with throttling would let a rate
      // limit and a rejected key each reset the other's evidence, so neither
      // would reach its threshold on a provider producing both.
      state.consecutiveCredential += 1;
      state.consecutive = 0;
      if (state.consecutiveCredential >= CREDENTIAL_BREAKER_THRESHOLD) {
        state.openUntilMs = now().getTime() + CREDENTIAL_BREAKER_COOLDOWN_MS;
      }
      return;
    }
    state.consecutiveCredential = 0;
    if (!THROTTLE_ERROR_CODES.has(errorCode)) {
      // A different failure is not evidence of throttling, so it must not
      // accumulate toward opening the breaker.
      state.consecutive = 0;
      return;
    }
    state.consecutive += 1;
    if (state.consecutive >= THROTTLE_BREAKER_THRESHOLD) {
      state.openUntilMs = now().getTime() + THROTTLE_BREAKER_COOLDOWN_MS;
    }
  };

  const runAttempt = async (
    operation: AiProviderOperation,
    input: Record<string, unknown>,
    provider: AiProviderPort,
    correlationId: string,
    attemptNumber: number,
    deadlineAtMs: number,
    controller?: AbortController,
  ) => {
    const id = newAttemptId();
    const started = now();
    const attemptController = controller ?? new AbortController();
    const semanticOperation = typeof input.usageOperation === "string" ? input.usageOperation : operation;
    const parentSignal = isAbortSignal(input.signal) ? input.signal : null;
    throwIfAborted(parentSignal);
    const onParentAbort = () => attemptController.abort(parentSignal?.reason);
    if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
    const attemptInput = { ...(input as Record<string, unknown>), signal: attemptController.signal };
    await persistStartAiProviderAttempt(attemptRepository, {
      id, correlationId, operation: semanticOperation, provider: provider.name,
      model: provider.model ?? null, attemptNumber, startedAt: started.toISOString(),
    }, log as Required<AiProviderLogger>);
    let timeoutId: unknown;
    let methodPromise: Promise<AiProviderResult> | undefined;
    let onAttemptAbort: (() => void) | undefined;
    try {
      const method = provider[operation];
      if (!method) throw new Error(`Provider ${provider.name} does not support ${operation}`);
      const remainingMs = Math.max(0, deadlineAtMs - now().getTime());
      if (remainingMs <= 0) {
        const error = timeoutError();
        attemptController.abort(error);
        throw error;
      }
      timeoutId = setTimeoutImpl(() => {
        attemptController.abort(timeoutError());
      }, remainingMs);
      methodPromise = Promise.resolve().then(() => method(attemptInput));
      const result = await Promise.race([
        methodPromise,
        new Promise<never>((_, reject) => {
          onAttemptAbort = () => {
            const signalReason = attemptController.signal.reason;
            reject(signalReason instanceof Error ? signalReason : timeoutError());
          };
          if (attemptController.signal.aborted) {
            onAttemptAbort();
            return;
          }
          attemptController.signal.addEventListener("abort", onAttemptAbort, { once: true });
        }),
      ]);
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
    } finally {
      if (timeoutId !== undefined) clearTimeoutImpl(timeoutId);
      if (onAttemptAbort) attemptController.signal.removeEventListener("abort", onAttemptAbort);
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
      void methodPromise?.catch(() => {});
    }
  };

  // Operations trait-marked `sequentialOperations` are billed per call.
  // Preserve their sequential behavior: an unsettled request is never raced
  // with a deadline or retried concurrently.
  const runSequentialAttempt = async (
    input: Record<string, unknown>,
    provider: AiProviderPort,
    operation: AiProviderOperation,
    correlationId: string,
    attemptNumber: number,
  ) => {
    const parentSignal = isAbortSignal(input.signal) ? input.signal : null;
    throwIfAborted(parentSignal);
    const id = newAttemptId();
    const started = now();
    await persistStartAiProviderAttempt(attemptRepository, {
      id,
      correlationId,
      operation,
      provider: provider.name,
      model: provider.model ?? null,
      attemptNumber,
      startedAt: started.toISOString(),
    }, log as Required<AiProviderLogger>);
    try {
      const method = provider[operation];
      if (!method) throw new Error(`Provider ${provider.name} does not support ${operation}`);
      const result = await method(input);
      await persistCompleteAiProviderAttempt(attemptRepository, {
        id,
        status: "succeeded",
        completedAt: now().toISOString(),
        latencyMs: Math.max(0, now().valueOf() - started.valueOf()),
        result,
      }, log as Required<AiProviderLogger>);
      return result;
    } catch (error) {
      const mutable = error as { traceId?: string; providerDiagnostics?: Record<string, unknown> };
      mutable.traceId ??= correlationId;
      mutable.providerDiagnostics = { ...mutable.providerDiagnostics, provider: provider.name };
      await persistCompleteAiProviderAttempt(attemptRepository, {
        id,
        status: "failed",
        completedAt: now().toISOString(),
        latencyMs: Math.max(0, now().valueOf() - started.valueOf()),
        error,
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
    const parentSignal = isAbortSignal(input.signal) ? input.signal : null;
    throwIfAborted(parentSignal);
    let attemptNumber = 0;
    for (const provider of available) {
      if (!provider[operation]) continue;
      if (isThrottleOpen(provider.name)) {
        // Skipped without a request. This is the whole point: the next 300
        // candidates cost nothing instead of three requests each.
        errors.push(new Error(`${provider.name} is throttled; skipped without calling`));
        continue;
      }
      throwIfAborted(parentSignal);
      const deadlineAtMs = now().getTime() + providerDeadlineMs;
      const controller = new AbortController();
      let providerAttempt = 0;
      try {
        while (
          providerAttempt < FALLBACK_PROVIDER_ATTEMPTS
          && !controller.signal.aborted
          && now().getTime() < deadlineAtMs
        ) {
          throwIfAborted(parentSignal);
          providerAttempt += 1;
          try {
            const result = await runAttempt(
              operation,
              input,
              provider,
              correlationId,
              ++attemptNumber,
              deadlineAtMs,
              controller,
            );
            recordThrottleOutcome(provider.name, null);
            return result;
          } catch (error) {
            errors.push(error);
            warn(operation, provider, error);
            throwIfAborted(parentSignal);
            const errorCode = classifyProviderError(error);
            if (traitsOf(provider.name, descriptors).haltsCascadeOnQuotaExhaustion && errorCode === "quota_exhausted") throw error;
            if (!isTransientProviderError(error)) throw error;
            if (
              providerAttempt >= FALLBACK_PROVIDER_ATTEMPTS
              || controller.signal.aborted
              || now().getTime() >= deadlineAtMs
            ) throw error;
            const remainingMs = Math.max(0, deadlineAtMs - now().getTime());
            await sleep(Math.min(retryDelayMs(providerAttempt, random), remainingMs));
          }
        }
      } catch (error) {
        throwIfAborted(parentSignal);
        // Once per call, not once per attempt: the threshold counts consecutive
        // throttled *calls*, so one call's three retries cannot open it alone.
        recordThrottleOutcome(provider.name, classifyProviderError(error) ?? "unknown");
        if (traitsOf(provider.name, descriptors).haltsCascadeOnQuotaExhaustion && classifyProviderError(error) === "quota_exhausted") {
          throw new AiProvidersExhaustedError(typeof input.usageOperation === "string" ? input.usageOperation : operation, errors, correlationId);
        }
      }
    }
    throw new AiProvidersExhaustedError(typeof input.usageOperation === "string" ? input.usageOperation : operation, errors, correlationId);
  };

  const executeOnce = async (operation: AiProviderOperation, input: Record<string, unknown>) => {
    const provider = available.find((candidate) => Boolean(candidate[operation]));
    if (!provider) throw new AiProvidersExhaustedError(operation, []);
    const correlationId = typeof input.traceId === "string" ? input.traceId : newAttemptId();
    const parentSignal = isAbortSignal(input.signal) ? input.signal : null;
    throwIfAborted(parentSignal);
    // The breaker applies here too. This path is bounded elsewhere -- the
    // semantic dedup budget caps it at a few calls per run -- so the saving is
    // small, but a 429 here is the same evidence of throttling as one from the
    // cascading path, and it should count toward the same streak rather than
    // being invisible to it.
    if (isThrottleOpen(provider.name)) {
      throw new AiProvidersExhaustedError(
        operation,
        [new Error(`${provider.name} is throttled; skipped without calling`)],
        correlationId,
      );
    }
    const controller = new AbortController();
    try {
      const result = await runAttempt(operation, input, provider, correlationId, 1, now().getTime() + providerDeadlineMs, controller);
      recordThrottleOutcome(provider.name, null);
      return result;
    } catch (error) {
      throwIfAborted(parentSignal);
      recordThrottleOutcome(provider.name, classifyProviderError(error) ?? "unknown");
      warn(operation, provider, error);
      throw new AiProvidersExhaustedError(operation, [error], (error as { traceId?: string }).traceId ?? correlationId);
    }
  };

  const executeFactSearch = async (input: Record<string, unknown>) => {
    const exclusive = available.find(
      (candidate) => traitsOf(candidate.name, descriptors).exclusiveOperations?.includes("searchFact") && candidate.searchFact,
    );
    if (!exclusive) return execute("searchFact", input);
    const correlationId = typeof input.traceId === "string" ? input.traceId : newAttemptId();
    const parentSignal = isAbortSignal(input.signal) ? input.signal : null;
    throwIfAborted(parentSignal);
    try {
      return await runSequentialAttempt(input, exclusive, "searchFact", correlationId, 1);
    } catch (error) {
      throwIfAborted(parentSignal);
      warn("searchFact", exclusive, error);
      if (!isTransientProviderError(error)) throw new AiProvidersExhaustedError("searchFact", [error], correlationId);
      try {
        await sleep(250);
        throwIfAborted(parentSignal);
        return await runSequentialAttempt(input, exclusive, "searchFact", correlationId, 2);
      } catch (retryError) {
        warn("searchFact", exclusive, retryError);
        throw new AiProvidersExhaustedError("searchFact", [error, retryError], correlationId);
      }
    }
  };

  const testConnection = async (providerId: string, operationLabel = `testConnection:${providerId}`) => {
    const candidate = available.find((provider) => provider.name === providerId && provider.testConnection);
    if (!candidate?.testConnection) throw new AiProvidersExhaustedError(operationLabel, []);
    return candidate.testConnection();
  };

  return {
    names: available.map((provider) => provider.name),
    generateStructured: (input) => execute("generateStructured", input),
    generateStructuredOnce: (input) => executeOnce("generateStructured", input),
    searchNews: (input) => execute("searchNews", input),
    searchFeeds: (input) => execute("searchFeeds", input),
    searchFact: executeFactSearch,
    testConnection,
    testExaConnection: () => testConnection("exa", "testExaConnection"),
  };
}
