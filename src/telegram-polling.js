import { setTimeout as sleep } from "node:timers/promises";
import { TelegramError } from "./telegram.js";

const MAX_BACKOFF_MS = 30_000;
const LEASE_NAME = "telegram-control-poller";
const LEASE_TTL_SECONDS = 60;
const HEARTBEAT_INTERVAL_MS = 20_000;
const LEASE_ACQUIRE_TIMEOUT_MS = 70_000;
const LEASE_ACQUIRE_RETRY_MS = 2_000;

export class PollingLeaseLostError extends Error {
  constructor() {
    super("Telegram polling lease was lost");
    this.name = "PollingLeaseLostError";
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
  let attempt = 0;
  try {
    while (!signal.aborted) {
      try {
        const updates = await Promise.race([
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
        for (const update of updates) {
          if (signal.aborted) {
            break;
          }
          await Promise.race([
            handleUpdate(update, { signal: operationController.signal }),
            leaseLoss,
          ]);
          offset = Math.max(offset, update.update_id + 1);
        }
        attempt = 0;
      } catch (error) {
        if (error instanceof PollingLeaseLostError) {
          throw error;
        }
        if (
          error instanceof TelegramError &&
          (error.status === 409 || error.errorCode === 409)
        ) {
          throw error;
        }
        if (signal.aborted) {
          break;
        }
        log.error(
          JSON.stringify({
            event: "telegram_poll_retry",
            attempt,
            error_code: "poll_failed",
          }),
        );
        await sleepImpl(retryDelay(attempt++, random), undefined, { signal });
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
