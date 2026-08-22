import { createHash, randomUUID } from "node:crypto";

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

function safeText(value, maximum = 64) {
  const normalized = String(value ?? "").replace(/[^A-Za-z0-9_.:-]/g, "");
  return normalized.slice(0, maximum) || null;
}

function safeStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

export class ProviderDiagnosticError extends Error {
  constructor(errorCode, diagnostics = {}, cause) {
    super(errorCode, cause ? { cause } : undefined);
    this.name = "ProviderDiagnosticError";
    this.code = errorCode;
    this.providerDiagnostics = diagnostics;
  }
}

export function providerDiagnosticError(errorCode, diagnostics, cause) {
  return new ProviderDiagnosticError(errorCode, diagnostics, cause);
}

export function classifySafeProviderError(error) {
  const explicit = error?.providerDiagnostics?.errorCode ?? error?.code;
  if (SAFE_ERROR_CODES.has(explicit)) return explicit;
  const status = safeStatus(error?.status ?? error?.statusCode);
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 402) return "quota_exhausted";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_unavailable";
  if (["AbortError", "TimeoutError"].includes(error?.name)) return "timeout";
  if (["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"].includes(error?.code)) return "network_error";
  if (error?.name === "ZodError" || error instanceof SyntaxError) return "invalid_response";
  return "provider_failed";
}

export function safeAttemptDiagnostics(error, result) {
  const source = error?.providerDiagnostics ?? result?.providerDiagnostics ?? {};
  const usage = source.usage ?? result?.usageEvents?.at?.(-1) ?? null;
  const errorCode = error ? classifySafeProviderError(error) : null;
  const httpStatus = safeStatus(source.httpStatus ?? error?.status ?? error?.statusCode);
  const errorType = safeText(source.errorType ?? error?.name ?? "", 48);
  const providerCode = safeText(source.providerCode ?? error?.code ?? "", 64);
  return {
    errorCode,
    httpStatus,
    providerResponseId: safeText(source.providerResponseId ?? usage?.providerResponseId, 256),
    responseStatus: safeText(source.responseStatus),
    incompleteReason: safeText(source.incompleteReason),
    refusal: typeof source.refusal === "boolean" ? source.refusal : null,
    inputTokens: Number.isSafeInteger(usage?.inputTokens) ? usage.inputTokens : null,
    outputTokens: Number.isSafeInteger(usage?.outputTokens) ? usage.outputTokens : null,
    reasoningTokens: Number.isSafeInteger(usage?.reasoningTokens) ? usage.reasoningTokens : null,
    errorFingerprint: error
      ? createHash("sha256")
          .update(JSON.stringify([errorCode, httpStatus, providerCode, errorType]))
          .digest("hex")
      : null,
  };
}

export function isTransientProviderError(error) {
  return TRANSIENT_ERROR_CODES.has(classifySafeProviderError(error));
}

export function newAttemptId() {
  return randomUUID();
}
