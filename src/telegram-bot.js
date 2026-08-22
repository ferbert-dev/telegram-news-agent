import { randomUUID } from "node:crypto";
import {
  closeDatabaseClient,
  createDatabaseClient,
} from "./database.js";
import { createAiProvider } from "./ai-provider.js";
import { getNewsEditor } from "./editor.js";
import { NewsRepository } from "./news-repository.js";
import {
  getNotionAuditConfig,
  NotionAuditLogger,
  withNotionAudit,
} from "./notion-audit.js";
import {
  handleControlUpdate,
  ControlError,
  deliverReviewDraft,
  isTerminalControlError,
} from "./telegram-control.js";
import {
  ensurePollingMode,
  getPollingConfig,
  pollTelegram,
} from "./telegram-polling.js";
import { callTelegram, getTelegramConfig } from "./telegram.js";
import {
  deliverTelegramNewsJobOutcome,
  getTelegramNewsJobsConfig,
  runTelegramNewsJobWorker,
} from "./telegram-news-jobs.js";
import {
  runCheckpointedNewsSearch,
  runTieredNewsSearch,
} from "./news-search.js";
import { runNewsScheduler } from "./news-scheduler.js";
import { publishApprovedDraft } from "./publish.js";
import { publishScheduledDraft as publishScheduledDraftWithPolicy } from "./scheduled-publication.js";
import { runWorkflow } from "./workflow.js";

const { token, channelId } = getTelegramConfig();
const polling = getPollingConfig();
const newsJobs = getTelegramNewsJobsConfig();
const databaseClient = createDatabaseClient();
const repository = new NewsRepository(databaseClient);
const auditLogger = new NotionAuditLogger(getNotionAuditConfig());
const aiProvider = createAiProvider(process.env, { attemptRepository: repository });
const editor = getNewsEditor();
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
      description: "Search now using your saved news settings",
    },
    {
      command: "settings",
      description: "Configure language, topics, publishing, and schedule",
    },
    {
      command: "stats",
      description: "Show today's AI usage and estimated cost",
    },
    {
      command: "status",
      description: "Show database, provider, and release status",
    },
    {
      command: "labs",
      description: "Configure experimental news features",
    },
  ],
});

async function runNews({ updateId, userId, chatId }) {
  const settings = await repository.getOrCreateNewsSettings({
    channelId,
    reviewChatId: chatId,
    updatedBy: userId,
  });
  return runCheckpointedNewsSearch({
    updateId,
    runWorkflow,
    repository,
    aiProvider,
    settings,
    telegram: { token, channelId },
    editor,
  });
}

async function runDurableNewsJob(job, { signal }) {
  signal?.throwIfAborted();
  return withNotionAudit(
    auditLogger,
    {
      name: "Telegram /news - background run",
      objective: `Complete durable Telegram news job ${job.id} for settings version ${job.settings_snapshot?.version ?? "unknown"}.`,
    },
    async (auditRun) => {
      const value = await runCheckpointedNewsSearch({
        updateId: job.request_update_id,
        runWorkflow,
        repository,
        aiProvider,
        settings: job.settings_snapshot,
        telegram: { token, channelId },
        editor,
      });
      return {
        value,
        auditResult: `Durable manual news outcome: ${value.status}.`,
        auditLinks: auditRun.pageUrl,
      };
    },
    {
      outbox: repository,
      sanitizeError: () => "telegram_news_job_failed",
    },
  );
}

async function runScheduledNews(settings) {
  return runTieredNewsSearch({
    runWorkflow,
    repository,
    aiProvider,
    settings: { ...settings, approvalPolicy: "manual" },
    telegram: { token, channelId },
    editor,
  });
}

async function publishScheduledDraft({ draftId }) {
  return publishScheduledDraftWithPolicy({
    repository,
    aiProvider,
    token,
    channelId,
    draftId,
    publishDraft: publishApprovedDraft,
  });
}

async function withScheduledAudit({ claim, settings }, operation) {
  return withNotionAudit(
    auditLogger,
    {
      name: "Telegram scheduler - news run",
      objective: `Run scheduled news occurrence ${claim.schedule_run_id} using settings version ${settings.version}.`,
    },
    async (auditRun) => {
      const value = await operation();
      return {
        value,
        auditResult: `Scheduled news outcome: ${value.status}.`,
        auditLinks: auditRun.pageUrl,
      };
    },
    {
      outbox: repository,
      sanitizeError: () => "scheduled_run_failed",
    },
  );
}

async function handleUpdate(update, { classification } = {}) {
  try {
    const result = await handleControlUpdate(update, {
      botUsername: bot.username,
      botId: bot.id,
      token,
      channelId,
      repository,
      aiProvider,
      auditLogger,
      callTelegram,
      runNews,
      durableNewsJobsEnabled: newsJobs.enabled,
      appVersion: process.env.APP_VERSION ?? "local",
    });
    if (!result.handled) {
      const claimed = await repository.claimTelegramUpdate(
        update.update_id,
        classification?.kind ?? "ignored",
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
        : error instanceof ControlError &&
            error.code === "publication_unresolved"
          ? "Telegram may have accepted the publication, so automatic retry is stopped. Reconcile the draft before publishing again."
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
    if (!isTerminalControlError(error)) {
      throw error;
    }
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
    scheduler: "database",
    durable_news_jobs: newsJobs.enabled ? "enabled" : "off",
    bot_id: bot.id,
    ai_providers: aiProvider.names,
  }),
);
const services = [];
try {
  const pollingService = pollTelegram({
    token,
    repository,
    ownerId: randomUUID(),
    callTelegram,
    handleUpdate,
    signal: controller.signal,
  });
  const schedulerService = runNewsScheduler({
    signal: controller.signal,
    repository,
    runNews: runScheduledNews,
    publishDraft: publishScheduledDraft,
    deliverReviewDraft: (input) =>
      deliverReviewDraft({
        ...input,
        token,
        repository,
        callTelegram,
      }),
    notifyAdmin: (chatId, text) =>
      callTelegram(token, "sendMessage", { chat_id: chatId, text }),
    withAudit: withScheduledAudit,
  });
  services.push(pollingService, schedulerService);
  if (newsJobs.enabled) {
    services.push(
      runTelegramNewsJobWorker({
        signal: controller.signal,
        repository,
        runNewsJob: runDurableNewsJob,
        deliverOutcome: (job, { signal }) =>
          deliverTelegramNewsJobOutcome({
            job,
            repository,
            signal,
            deliverReview: (input) =>
              deliverReviewDraft({
                ...input,
                token,
                repository,
                callTelegram,
              }),
            sendAdmin: (chatId, text) =>
              callTelegram(token, "sendMessage", {
                chat_id: chatId,
                text,
              }),
          }),
        pollIntervalMs: newsJobs.pollIntervalMs,
        staleAfterSeconds: newsJobs.staleAfterSeconds,
        maxExecutionAttempts: newsJobs.maxExecutionAttempts,
        maxDeliveryAttempts: newsJobs.maxDeliveryAttempts,
      }),
    );
  }
  await Promise.all(services);
} finally {
  controller.abort();
  await Promise.allSettled(services);
  await closeDatabaseClient(databaseClient);
  console.log(JSON.stringify({ event: "telegram_control_stopped" }));
}
