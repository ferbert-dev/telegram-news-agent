import { setTimeout as sleep } from "node:timers/promises";

const MAX_BACKOFF_MS = 30_000;

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
}) {
  const leaseName = "telegram-control-poller";
  if (!(await repository.acquirePipelineLease(leaseName, ownerId, 60))) {
    throw new Error("Another Telegram polling process holds the database lease");
  }

  let offset = 0;
  let attempt = 0;
  try {
    while (!signal.aborted) {
      try {
        if (!(await repository.acquirePipelineLease(leaseName, ownerId, 60))) {
          throw new Error("Telegram polling lease was lost");
        }
        const updates = await callTelegram(
          token,
          "getUpdates",
          {
            offset,
            timeout: 25,
            allowed_updates: ["message", "callback_query"],
          },
          { signal },
        );
        attempt = 0;
        for (const update of updates) {
          if (signal.aborted) {
            break;
          }
          await handleUpdate(update);
          offset = Math.max(offset, update.update_id + 1);
        }
      } catch (error) {
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
    await repository.releasePipelineLease(leaseName, ownerId);
  }
}
