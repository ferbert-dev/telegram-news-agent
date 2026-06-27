import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "./database.js";
import { createGeminiClient } from "./gemini-client.js";
import { NewsRepository } from "./news-repository.js";
import {
  getNotionAuditConfig,
  NotionAuditLogger,
} from "./notion-audit.js";
import { handleControlUpdate, ControlError } from "./telegram-control.js";
import {
  ensurePollingMode,
  getPollingConfig,
  pollTelegram,
} from "./telegram-polling.js";
import { callTelegram, getTelegramConfig } from "./telegram.js";
import { runWorkflow } from "./workflow.js";

const { token, channelId } = getTelegramConfig();
const polling = getPollingConfig();
const repository = new NewsRepository(createDatabaseClient());
const auditLogger = new NotionAuditLogger(getNotionAuditConfig());
const bot = await callTelegram(token, "getMe", {});
const controller = new AbortController();
let stopping = false;

await ensurePollingMode({
  token,
  migrateWebhook: polling.migrateWebhook,
  callTelegram,
});
await callTelegram(token, "setMyCommands", {
  commands: [
    {
      command: "news",
      description: "Create a news draft for private review",
    },
  ],
});

async function runNews() {
  const { client: aiClient, model } = createGeminiClient();
  const result = await runWorkflow({
    approvalPolicy: "manual",
    repository,
    aiClient,
    model,
    query: "Most important AI development from the last 48 hours",
    keywords: ["AI", "model", "research", "agent"],
    windowHours: 48,
  });
  return { draftId: result.draft.id, preview: result.preview };
}

async function handleUpdate(update) {
  try {
    const result = await handleControlUpdate(update, {
      botUsername: bot.username,
      token,
      channelId,
      repository,
      auditLogger,
      callTelegram,
      runNews,
    });
    if (!result.handled) {
      const claimed = await repository.claimTelegramUpdate(
        update.update_id,
        "ignored",
      );
      if (claimed.claimed) {
        const finished = await repository.finishTelegramUpdate(
          update.update_id,
          claimed.claim_token,
          "completed",
        );
        if (!finished) {
          throw new ControlError("update_claim_lost", "Update claim was lost");
        }
      } else if (claimed.claim_status === "busy") {
        throw new ControlError(
          "update_in_progress",
          "Telegram update is still being processed",
        );
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_control_error",
        update_id: update.update_id,
        error_code:
          error instanceof ControlError ? error.code : "internal_error",
      }),
    );
    const callback = update.callback_query;
    const chatId = update.message?.chat?.id ?? callback?.message?.chat?.id;
    const text =
      error instanceof ControlError && error.code === "forbidden"
        ? "Administrator access required."
        : "The request could not be completed.";
    if (callback?.id) {
      await callTelegram(token, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text,
        show_alert: true,
      }).catch(() => {});
    } else if (chatId != null) {
      await callTelegram(token, "sendMessage", {
        chat_id: chatId,
        text,
      }).catch(() => {});
    }
    throw error;
  }
}

function stop(signalName) {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(
    JSON.stringify({ event: "telegram_control_stopping", signal: signalName }),
  );
  controller.abort();
  setTimeout(() => process.exit(1), 30_000).unref();
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.log(
  JSON.stringify({
    event: "telegram_control_started",
    mode: "polling",
    bot_id: bot.id,
  }),
);
await pollTelegram({
  token,
  repository,
  ownerId: randomUUID(),
  callTelegram,
  handleUpdate,
  signal: controller.signal,
});
