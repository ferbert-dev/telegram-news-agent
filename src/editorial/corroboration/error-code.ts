/**
 * A short, log-safe name for why something failed.
 *
 * Only the machine-readable code travels -- never the message. Provider
 * messages can quote the request, the URL it went to or the provider's own
 * response body, and this value ends up in container logs and in
 * reviewer_notes, both of which outlive the run.
 *
 * `AiProvidersExhaustedError` is an AggregateError whose own code only says
 * that every provider failed; the inner codes say how (`timeout`,
 * `authentication_failed`), which is the part worth reading, so they are
 * appended.
 */
export function errorCodeOf(error: unknown): string {
  const own = codeOrName(error);
  const inner =
    error instanceof AggregateError
      ? [...new Set(error.errors.map(codeOrName).filter((code) => code !== "error"))]
      : [];
  return inner.length ? `${own}:${inner.join(",")}`.slice(0, 200) : own;
}

// A code is a short identifier that starts with a letter. The digit limit is
// what keeps a key or a UUID that some error put in its `code` field out of
// the log: real codes (`timeout`, `authentication_failed`, `http_429`) carry
// at most a status number.
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;
const MAX_DIGITS = 3;

function isSafeCode(value: string): boolean {
  return SAFE_CODE.test(value) && (value.match(/[0-9]/g)?.length ?? 0) <= MAX_DIGITS;
}

function codeOrName(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, errorCode, name } = error as {
      code?: unknown;
      errorCode?: unknown;
      name?: unknown;
    };
    for (const candidate of [code, errorCode]) {
      if (typeof candidate === "string" && isSafeCode(candidate)) return candidate;
    }
    // A bare `Error` says nothing; a specific class (`AbortError`,
    // `TimeoutError`) does.
    if (typeof name === "string" && name !== "Error" && isSafeCode(name)) return name;
  }
  return "error";
}
