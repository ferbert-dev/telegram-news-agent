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

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function codeOrName(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, errorCode, name } = error as {
      code?: unknown;
      errorCode?: unknown;
      name?: unknown;
    };
    for (const candidate of [code, errorCode]) {
      if (typeof candidate === "string" && SAFE_CODE.test(candidate)) return candidate;
    }
    // A bare `Error` says nothing; a specific class (`AbortError`,
    // `TimeoutError`) does.
    if (typeof name === "string" && name !== "Error" && SAFE_CODE.test(name)) return name;
  }
  return "error";
}
