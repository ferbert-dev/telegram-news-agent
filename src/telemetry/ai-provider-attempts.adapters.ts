import { createHash, randomUUID } from "node:crypto";

import type {
  AiProviderAttemptStatus,
  AiProviderAttemptsPersistence,
  CompleteAiProviderAttemptInput,
  StartAiProviderAttemptInput,
} from "../ai-provider-attempts-persistence.contracts.js";

const TRANSIENT_ERROR_CODES = new Set([
  "timeout",
  "rate_limited",
  "network_error",
  "upstream_unavailable",
]);

const SAFE_ERROR_CODES = new Set([
  "authentication_failed",
  "quota_exhausted",
  "timeout",
  "rate_limited",
  "network_error",
  "upstream_unavailable",
  "structured_output_missing",
  "schema_validation_failed",
  "model_refusal",
  "invalid_response",
  "provider_failed",
]);

const QUOTA_ERROR_CODES = new Set([
  "insufficient_quota",
  "exa_daily_search_cap",
  "resource_exhausted",
]);

export type KnownProviderErrorCode =
  | "authentication_failed"
  | "quota_exhausted"
  | "timeout"
  | "rate_limited"
  | "network_error"
  | "upstream_unavailable"
  | "structured_output_missing"
  | "schema_validation_failed"
  | "model_refusal"
  | "invalid_response"
  | "provider_failed";

export type SafeProviderErrorCode = KnownProviderErrorCode | null;

export type AiProviderAttemptTelemetryLogger = {
  warn: (message: string) => void;
};

export interface AiProviderAttemptTelemetryWriter
  extends Pick<
    AiProviderAttemptsPersistence,
    "startAiProviderAttempt" | "completeAiProviderAttempt"
  > {}

export type TelemetryAttemptStartInput = Omit<
  StartAiProviderAttemptInput,
  "startedAt"
> & {
  startedAt?: string;
};

export type TelemetryAttemptFailureInput = {
  id: string;
  status: Exclude<AiProviderAttemptStatus, "started">;
  completedAt: string;
  latencyMs: number;
  error: unknown;
};

export type TelemetryAttemptSuccessInput = {
  id: string;
  status: Exclude<AiProviderAttemptStatus, "started">;
  completedAt: string;
  latencyMs: number;
  result?: unknown;
};

function getProviderErrorCode(error: unknown): string | null {
  return [
    (error as { providerDiagnostics?: { errorCode?: string } })?.providerDiagnostics
      ?.errorCode,
    (error as { error?: { code?: string; type?: string } })?.error?.code,
    (error as { error?: { code?: string; type?: string } })?.error?.type,
    (error as { code?: string; type?: string })?.code,
    (error as { code?: string; type?: string })?.type,
  ]
    .map((value) =>
      typeof value === "string" && value.trim().length > 0 ? value : null,
    )
    .find((value) => value !== null) ?? null;
}

function normalizeCode(value: string | null): string | null {
  if (!value) return null;
  return String(value)
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function safeText(value: unknown, maximum = 64): string | null {
  const normalized = String(value ?? "").replace(/[^A-Za-z0-9_.:-]/g, "");
  return normalized.slice(0, maximum) || null;
}

function safeStatus(value: unknown): number | null {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export class ProviderDiagnosticError extends Error {
  public readonly providerDiagnostics: Record<string, unknown>;
  public readonly code: KnownProviderErrorCode;

  constructor(
    errorCode: KnownProviderErrorCode,
    diagnostics: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(errorCode, cause ? { cause } : undefined);
    this.name = "ProviderDiagnosticError";
    this.code = errorCode;
    this.providerDiagnostics = diagnostics;
  }
}

export function providerDiagnosticError(
  errorCode: KnownProviderErrorCode,
  diagnostics: Record<string, unknown> = {},
  cause?: Error,
) {
  return new ProviderDiagnosticError(errorCode, diagnostics, cause);
}

export function classifySafeProviderError(
  error: unknown,
): SafeProviderErrorCode {
  const explicit = getProviderErrorCode(error);
  const normalized = normalizeCode(explicit);
  if (normalized && QUOTA_ERROR_CODES.has(normalized)) return "quota_exhausted";
  if (
    normalized &&
    SAFE_ERROR_CODES.has(normalized as KnownProviderErrorCode)
  ) {
    return normalized as KnownProviderErrorCode;
  }
  const status = safeStatus(
    (error as { status?: unknown; statusCode?: unknown })?.status ??
      (error as { status?: unknown; statusCode?: unknown })?.statusCode,
  );
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 402) return "quota_exhausted";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500) return "upstream_unavailable";
  if ((error as { name?: string })?.name === "AbortError") return "timeout";
  if ((error as { name?: string })?.name === "TimeoutError") return "timeout";
  if ((error as { code?: string })?.code === "ECONNRESET") return "network_error";
  if ((error as { code?: string })?.code === "ENOTFOUND") return "network_error";
  if ((error as { code?: string })?.code === "ETIMEDOUT") return "network_error";
  if ((error as { code?: string })?.code === "ECONNREFUSED") return "network_error";
  if ((error as { name?: string })?.name === "ZodError") return "invalid_response";
  if ((error as { name?: string })?.name === "SyntaxError" || error instanceof SyntaxError)
    return "invalid_response";
  return "provider_failed";
}

export function safeAttemptDiagnostics(
  error: unknown,
  result?: {
    providerDiagnostics?: Record<string, unknown> | null;
    usageEvents?: unknown[];
  },
): Omit<
  CompleteAiProviderAttemptInput,
  "id" | "status" | "completedAt" | "latencyMs"
> {
  const source = (error as { providerDiagnostics?: Record<string, unknown> } | null)?.providerDiagnostics ??
    (result as { providerDiagnostics?: Record<string, unknown> } | null)?.providerDiagnostics ??
    {};
  const usage = (typeof source === "object" && source !== null && "usage" in source
    ? (source as { usage?: unknown }).usage
    : null) ??
    ((result as { usageEvents?: { providerResponseId?: unknown }[] } | null)
      ?.usageEvents?.at(-1) ?? null);
  const errorCode = error ? classifySafeProviderError(error) : null;
  const httpStatus = safeStatus(
    source?.httpStatus ??
      (error as { status?: unknown; statusCode?: unknown })?.status ??
      (error as { status?: unknown; statusCode?: unknown })?.statusCode,
  );
  const errorType = safeText(
    source?.errorType ?? (error as { name?: string })?.name ?? "",
    48,
  );
  const providerCode = safeText(source?.providerCode ?? (error as { code?: unknown })?.code, 64);
  const usageTokens = typeof usage === "object" && usage !== null
    ? (usage as Record<string, unknown>)
    : null;
  const inputTokens = usageTokens && Number.isSafeInteger(usageTokens.inputTokens as number)
    ? Number(usageTokens.inputTokens)
    : null;
  const outputTokens = usageTokens && Number.isSafeInteger(usageTokens.outputTokens as number)
    ? Number(usageTokens.outputTokens)
    : null;
  const reasoningTokens = usageTokens && Number.isSafeInteger(usageTokens.reasoningTokens as number)
    ? Number(usageTokens.reasoningTokens)
    : null;

  return {
    errorCode,
    httpStatus,
    providerResponseId: safeText(
      source?.providerResponseId ?? usageTokens?.providerResponseId,
      256,
    ),
    responseStatus: safeText(source?.responseStatus),
    incompleteReason: safeText(source?.incompleteReason),
    refusal:
      typeof source?.refusal === "boolean" ? source?.refusal : null,
    inputTokens: Number.isSafeInteger(inputTokens) ? inputTokens : null,
    outputTokens: Number.isSafeInteger(outputTokens) ? outputTokens : null,
    reasoningTokens: Number.isSafeInteger(reasoningTokens) ? reasoningTokens : null,
    errorFingerprint: error
      ? createHash("sha256")
          .update(JSON.stringify([errorCode, httpStatus, providerCode, errorType]))
          .digest("hex")
      : null,
  };
}

export function isTransientProviderError(error: unknown): boolean {
  const errorCode = classifySafeProviderError(error);
  return errorCode !== null && TRANSIENT_ERROR_CODES.has(errorCode);
}

export function newAttemptId(): string {
  return randomUUID();
}

export function toStartInput(
  input: TelemetryAttemptStartInput,
): StartAiProviderAttemptInput {
  return {
    id: input.id ?? newAttemptId(),
    correlationId: input.correlationId,
    operation: input.operation,
    provider: input.provider,
    model: input.model ?? null,
    attemptNumber: input.attemptNumber,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
}

function buildAttemptCompletion(
  input: TelemetryAttemptFailureInput | TelemetryAttemptSuccessInput,
): Omit<
  CompleteAiProviderAttemptInput,
  "id" | "status" | "completedAt" | "latencyMs"
> {
  if ("error" in input && input.error !== undefined) {
    return safeAttemptDiagnostics(input.error);
  }
  return safeAttemptDiagnostics(
    null,
    (input as TelemetryAttemptSuccessInput).result as
      | {
          providerDiagnostics?: Record<string, unknown> | null;
          usageEvents?: unknown[];
        }
      | undefined,
  );
}

export async function persistStartAiProviderAttempt(
  repository: AiProviderAttemptTelemetryWriter | null | undefined,
  input: StartAiProviderAttemptInput,
  logger: AiProviderAttemptTelemetryLogger = console,
): Promise<unknown | null> {
  if (!repository?.startAiProviderAttempt) return null;
  try {
    return await repository.startAiProviderAttempt(input);
  } catch {
    logger.warn(
      JSON.stringify({
        event: "ai_provider_attempt_telemetry_failed",
        operation: input.operation,
      }),
    );
    return null;
  }
}

export async function persistCompleteAiProviderAttempt(
  repository: AiProviderAttemptTelemetryWriter | null | undefined,
  input: TelemetryAttemptFailureInput | TelemetryAttemptSuccessInput,
  logger: AiProviderAttemptTelemetryLogger = console,
): Promise<unknown | null> {
  if (!repository?.completeAiProviderAttempt) return null;
  const diagnostics = buildAttemptCompletion(input);
  try {
    return await repository.completeAiProviderAttempt({
      id: input.id,
      status: input.status,
      completedAt: input.completedAt,
      latencyMs: input.latencyMs,
      ...diagnostics,
    });
  } catch {
    logger.warn(
      JSON.stringify({
        event: "ai_provider_attempt_telemetry_failed",
        operation: null,
      }),
    );
    return null;
  }
}
