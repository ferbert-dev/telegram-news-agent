import { callTelegram as legacyCallTelegram } from "../../telegram.js";

/**
 * The exact call shape every typed Telegram consumer already takes as a
 * constructor parameter (TelegramBotApiGateway, TelegramBotApiOutcomeRenderer,
 * the TelegramLegacy*Gateway classes, TelegramPollingWorker). Until now nothing
 * in TypeScript produced one — only legacy src/telegram.js did.
 */
export type TelegramCall = (
  token: string,
  method: string,
  body: unknown,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export type LegacyCallTelegram = (
  token: string,
  method: string,
  body: unknown,
  options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
) => Promise<unknown>;

/**
 * Typed adapter over the legacy Bot API caller. Deliberately a pass-through:
 * `telegram.js` already surfaces a non-2xx or `ok:false` response as a
 * `TelegramError` carrying `status`/`errorCode`, which is what makes HTTP 409
 * distinguishable as a typed conflict — the polling worker treats 409 as fatal
 * rather than transient, and an existing legacy test pins that. Re-implementing
 * the request here would duplicate that error contract; wrapping or
 * re-throwing would erase it.
 */
export function createTelegramCallAdapter(
  callTelegramImpl: LegacyCallTelegram = legacyCallTelegram as LegacyCallTelegram,
): TelegramCall {
  return (token, method, body, options) =>
    callTelegramImpl(token, method, body, options);
}
