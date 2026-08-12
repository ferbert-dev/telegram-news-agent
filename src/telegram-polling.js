import { setTimeout as sleep } from "node:timers/promises";
import { TelegramError } from "./telegram.js";

const MAX_BACKOFF_MS = 30_000;
const LEASE_NAME = "telegram-control-poller";
const LEASE_TTL_SECONDS = 60;
const HEARTBEAT_INTERVAL_MS = 20_000;
const LEASE_ACQUIRE_TIMEOUT_MS = 70_000;
const LEASE_ACQUIRE_RETRY_MS = 2_000;
const MAX_UPDATE_ATTEMPTS = 3;
const MAX_FAILURE_LEDGER_ATTEMPTS = 3;
const ADMIN_CALLBACK_PREFIXES = ["lab:", "cfg:", "news:"];
const UPDATE_BODY_FIELDS = [
  "message",
  "callback_query",
  "message_reaction",
  "message_reaction_count",
];

export class PollingLeaseLostError extends Error {
  constructor() {
    super("Telegram polling lease was lost");
    this.name = "PollingLeaseLostError";
  }
}

export class TelegramUpdateProtocolError extends Error {
  constructor(code) {
    super(`Invalid Telegram update protocol payload: ${code}`);
    this.name = "TelegramUpdateProtocolError";
    this.code = code;
  }
}

export class TelegramUpdatePersistenceError extends Error {
  constructor() {
    super("Telegram update failure ledger remained unavailable");
    this.name = "TelegramUpdatePersistenceError";
  }
}

export class NonRetryableTelegramUpdateError extends Error {
  constructor(code = "non_retryable_update") {
    super("Telegram update cannot be retried safely");
    this.name = "NonRetryableTelegramUpdateError";
    this.code = sanitizeErrorCode(code, "non_retryable_update");
    this.retryable = false;
  }
}

export function getPollingConfig(env = process.env) {
  const mode = env.TELEGRAM_UPDATE_MODE?.trim().toLowerCase();
  if (mode !== "polling") {
    throw new Error("TELEGRAM_UPDATE_MODE=polling is required");
  }
  return {
    migrateWebhook:
      env.TELEGRAM_POLLING_MIGRATE_WEBHOOK?.trim().toLowerCase() === "true",
  };
}

export function retryDelay(attempt, random = Math.random) {
  const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt, 6));
  return Math.floor(random() * ceiling);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeErrorCode(value, fallback) {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)
    ? value
    : fallback;
}

function malformed(updateId, errorCode) {
  return {
    updateId,
    kind: "malformed",
    terminal: true,
    errorCode,
  };
}

export function classifyTelegramUpdate(update) {
  if (
    !isRecord(update) ||
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0
  ) {
    throw new TelegramUpdateProtocolError("invalid_update_id");
  }

  const updateId = update.update_id;
  const presentFields = UPDATE_BODY_FIELDS.filter(
    (field) => update[field] !== undefined,
  );
  if (presentFields.length > 1) {
    return malformed(updateId, "multiple_update_bodies");
  }

  if (update.callback_query !== undefined) {
    const callback = update.callback_query;
    if (
      !isRecord(callback) ||
      typeof callback.id !== "string" ||
      !callback.id
    ) {
      return malformed(updateId, "invalid_callback_query");
    }
    const data = callback.data;
    if (typeof data === "string" && data.startsWith("aud:")) {
      return { updateId, kind: "public_feedback", terminal: false };
    }
    if (
      typeof data === "string" &&
      ADMIN_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix))
    ) {
      return { updateId, kind: "admin_callback", terminal: false };
    }
    return { updateId, kind: "ignored_callback", terminal: false };
  }

  if (update.message_reaction_count !== undefined) {
    const reaction = update.message_reaction_count;
    if (
      !isRecord(reaction) ||
      !isRecord(reaction.chat) ||
      !Number.isSafeInteger(reaction.chat.id) ||
      !Number.isSafeInteger(reaction.message_id) ||
      !Number.isSafeInteger(reaction.date) ||
      !Array.isArray(reaction.reactions)
    ) {
      return malformed(updateId, "invalid_reaction_count");
    }
    return { updateId, kind: "aggregate_reaction", terminal: false };
  }

  if (update.message_reaction !== undefined) {
    return isRecord(update.message_reaction)
      ? { updateId, kind: "ignored_individual_reaction", terminal: false }
      : malformed(updateId, "invalid_individual_reaction");
  }

  if (update.message !== undefined) {
    return isRecord(update.message)
      ? { updateId, kind: "message", terminal: false }
      : malformed(updateId, "invalid_message");
  }

  return { updateId, kind: "ignored", terminal: false };
}

function classifyUpdateError(error) {
  if (error?.code === "update_in_progress") {
    return {
      busy: true,
      terminal: false,
      errorCode: "update_in_progress",
    };
  }
  if (
    error instanceof NonRetryableTelegramUpdateError ||
    error?.retryable === false
  ) {
    return {
      busy: false,
      terminal: true,
      errorCode: sanitizeErrorCode(error?.code, "non_retryable_update"),
    };
  }
  return {
    busy: false,
    terminal: false,
    errorCode: "update_handler_failed",
  };
}

function isTelegramConflict(error) {
  return (
    error instanceof TelegramError &&
    (error.status === 409 || error.errorCode === 409)
  );
}

export async function ensurePollingMode({
  token,
  migrateWebhook,
  callTelegram,
}) {
  const webhook = await callTelegram(token, "getWebhookInfo", {});
  if (!webhook?.url) {
    return;
  }
  if (!migrateWebhook) {
    throw new Error(
      "Telegram webhook is configured; set TELEGRAM_POLLING_MIGRATE_WEBHOOK=true for an explicit migration",
    );
  }
  await callTelegram(token, "deleteWebhook", {
    drop_pending_updates: false,
  });
}

async function acquirePollingLease({
  repository,
  ownerId,
  signal,
  sleepImpl,
  log,
  timeoutMs,
  retryMs,
  nowImpl,
}) {
  const deadline = nowImpl() + timeoutMs;
  let waitingLogged = false;

  while (!signal.aborted) {
    if (
      await repository.acquirePipelineLease(
        LEASE_NAME,
        ownerId,
        LEASE_TTL_SECONDS,
      )
    ) {
      return;
    }
    if (nowImpl() >= deadline) {
      throw new Error(
        "Another Telegram polling process still holds the database lease",
      );
    }
    if (!waitingLogged) {
      log.warn?.(
        JSON.stringify({
          event: "telegram_polling_lease_wait",
          timeout_ms: timeoutMs,
        }),
      );
      waitingLogged = true;
    }
    await sleepImpl(retryMs, undefined, { signal });
  }
}

export async function pollTelegram({
  token,
  repository,
  ownerId,
  callTelegram,
  handleUpdate,
  signal,
  random = Math.random,
  sleepImpl = sleep,
  log = console,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  leaseAcquireTimeoutMs = LEASE_ACQUIRE_TIMEOUT_MS,
  leaseAcquireRetryMs = LEASE_ACQUIRE_RETRY_MS,
  nowImpl = Date.now,
  maxUpdateAttempts = MAX_UPDATE_ATTEMPTS,
  maxFailureLedgerAttempts = MAX_FAILURE_LEDGER_ATTEMPTS,
}) {
  await acquirePollingLease({
    repository,
    ownerId,
    signal,
    sleepImpl,
    log,
    timeoutMs: leaseAcquireTimeoutMs,
    retryMs: leaseAcquireRetryMs,
    nowImpl,
  });

  const leaseController = new AbortController();
  const operationController = new AbortController();
  const abortOperation = () => operationController.abort(signal.reason);
  signal.addEventListener("abort", abortOperation, { once: true });
  let rejectLeaseLoss;
  const leaseLoss = new Promise((_, reject) => {
    rejectLeaseLoss = reject;
  });
  const heartbeat = (async () => {
    try {
      while (!leaseController.signal.aborted) {
        await sleepImpl(heartbeatIntervalMs, undefined, {
          signal: leaseController.signal,
        });
        if (
          !(await repository.renewPipelineLease(
            LEASE_NAME,
            ownerId,
            LEASE_TTL_SECONDS,
          ))
        ) {
          throw new PollingLeaseLostError();
        }
      }
    } catch (error) {
      if (!leaseController.signal.aborted) {
        operationController.abort(error);
        rejectLeaseLoss(
          error instanceof PollingLeaseLostError
            ? error
            : new PollingLeaseLostError(),
        );
      }
    }
  })();

  let offset = 0;
  let pollAttempt = 0;
  let failureLedgerAttempt = 0;
  try {
    while (!signal.aborted) {
      let updates;
      try {
        updates = await Promise.race([
          callTelegram(
            token,
            "getUpdates",
            {
              offset,
              timeout: 25,
              allowed_updates: ["message", "callback_query"],
            },
            { signal: operationController.signal },
          ),
          leaseLoss,
        ]);
      } catch (error) {
        if (error instanceof PollingLeaseLostError) {
          throw error;
        }
        if (isTelegramConflict(error)) {
          throw error;
        }
        if (signal.aborted) {
          break;
        }
        log.error(
          JSON.stringify({
            event: "telegram_poll_retry",
            attempt: pollAttempt,
            error_code: "poll_failed",
          }),
        );
        await sleepImpl(retryDelay(pollAttempt++, random), undefined, {
          signal,
        });
        continue;
      }

      if (!Array.isArray(updates)) {
        throw new TelegramUpdateProtocolError("updates_not_array");
      }
      pollAttempt = 0;

      let retryCurrentUpdate = false;
      for (const update of updates) {
        if (signal.aborted) {
          break;
        }

        const classification = classifyTelegramUpdate(update);
        let failure = classification.terminal
          ? {
              terminal: true,
              errorCode: classification.errorCode,
            }
          : null;

        if (!failure) {
          try {
            await Promise.race([
              handleUpdate(update, {
                signal: operationController.signal,
                classification,
              }),
              leaseLoss,
            ]);
          } catch (error) {
            if (
              error instanceof PollingLeaseLostError ||
              isTelegramConflict(error)
            ) {
              throw error;
            }
            if (signal.aborted) {
              break;
            }
            failure = classifyUpdateError(error);
          }
        }

        if (failure?.busy) {
          log.error(
            JSON.stringify({
              event: "telegram_update_busy",
              update_id: classification.updateId,
              update_kind: classification.kind,
              error_code: failure.errorCode,
            }),
          );
          await sleepImpl(retryDelay(0, random), undefined, { signal });
          retryCurrentUpdate = true;
          break;
        }

        if (!failure) {
          failureLedgerAttempt = 0;
          offset = Math.max(offset, classification.updateId + 1);
          continue;
        }

        let recorded;
        try {
          recorded = await Promise.race([
            repository.recordTelegramUpdateFailure(
              classification.updateId,
              classification.kind,
              failure.errorCode,
              maxUpdateAttempts,
              failure.terminal,
              null,
            ),
            leaseLoss,
          ]);
          failureLedgerAttempt = 0;
        } catch (error) {
          if (error instanceof PollingLeaseLostError) {
            throw error;
          }
          if (signal.aborted) {
            break;
          }
          if (++failureLedgerAttempt >= maxFailureLedgerAttempts) {
            throw new TelegramUpdatePersistenceError();
          }
          log.error(
            JSON.stringify({
              event: "telegram_update_failure_ledger_retry",
              update_id: classification.updateId,
              attempt: failureLedgerAttempt,
              error_code: "failure_ledger_unavailable",
            }),
          );
          await sleepImpl(
            retryDelay(failureLedgerAttempt - 1, random),
            undefined,
            { signal },
          );
          retryCurrentUpdate = true;
          break;
        }

        if (!recorded.recorded && recorded.failure_status === "processing") {
          log.error(
            JSON.stringify({
              event: "telegram_update_busy",
              update_id: classification.updateId,
              update_kind: classification.kind,
              error_code: "claim_not_owned",
            }),
          );
          await sleepImpl(retryDelay(0, random), undefined, { signal });
          retryCurrentUpdate = true;
          break;
        }

        if (recorded.terminal) {
          log.warn?.(
            JSON.stringify({
              event:
                recorded.failure_status === "quarantined"
                  ? "telegram_update_quarantined"
                  : "telegram_update_already_terminal",
              update_id: classification.updateId,
              update_kind: classification.kind,
              attempt_count: recorded.attempt_count,
              error_code: failure.errorCode,
            }),
          );
          offset = Math.max(offset, classification.updateId + 1);
          continue;
        }

        log.error(
          JSON.stringify({
            event: "telegram_update_retry",
            update_id: classification.updateId,
            update_kind: classification.kind,
            attempt_count: recorded.attempt_count,
            error_code: failure.errorCode,
          }),
        );
        await sleepImpl(
          retryDelay(recorded.attempt_count - 1, random),
          undefined,
          { signal },
        );
        retryCurrentUpdate = true;
        break;
      }

      if (retryCurrentUpdate) {
        continue;
      }
    }
  } finally {
    signal.removeEventListener("abort", abortOperation);
    leaseController.abort();
    operationController.abort();
    try {
      await heartbeat;
    } finally {
      await repository.releasePipelineLease(LEASE_NAME, ownerId);
    }
  }
}
