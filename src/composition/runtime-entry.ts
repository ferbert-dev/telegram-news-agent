import "reflect-metadata";

import { once } from "node:events";
import { pathToFileURL } from "node:url";

import { callTelegram, getTelegramConfig } from "../telegram.js";
import { ensurePollingMode, getPollingConfig } from "../telegram-polling.js";
import { bootstrapRuntime, type RuntimeBootstrapRun } from "../runtime/runtime-bootstrap.js";
import {
  NEWS_SCHEDULER_WORKER,
  NewsAgentModule,
  TELEGRAM_POLLING_WORKER,
  type NewsAgentRuntimeIdentity,
} from "./news-agent.module.js";

/**
 * Resolves the bot's own identity before the container is built.
 *
 * `TelegramControlTransportHandler` needs the bot's username and numeric id to
 * decide whether a command is addressed to it, and neither is available from
 * configuration — only from Telegram. Doing it here keeps the module
 * definition synchronous and fails fast on a bad token, before anything
 * acquires a lease.
 */
export async function resolveRuntimeIdentity(
  token: string,
  channelId: string,
  call: typeof callTelegram = callTelegram,
): Promise<NewsAgentRuntimeIdentity> {
  const me = (await call(token, "getMe", {})) as { id?: number; username?: string };
  if (typeof me?.id !== "number" || typeof me?.username !== "string") {
    throw new Error("Telegram getMe did not return a usable bot identity");
  }
  return { botUsername: me.username, botId: me.id, channelId };
}

export type StartNewsAgentRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  identity?: NewsAgentRuntimeIdentity;
  stopGracePeriodMs?: number;
};

/**
 * Builds the composition root and starts both workers.
 *
 * Worker order is the readiness contract, not a preference: the Telegram
 * poller must own its lease before the scheduler begins, so the poller token
 * comes first.
 */
export async function startNewsAgentRuntime(
  options: StartNewsAgentRuntimeOptions = {},
): Promise<RuntimeBootstrapRun> {
  const env = options.env ?? process.env;
  // getTelegramConfig reads process.env directly and takes no argument, so the
  // bot token and channel are process-global even when `env` is supplied.
  // Stated rather than hidden: an `env` override changes AI, Notion and version
  // configuration but NOT which bot this talks to.
  const { token, channelId } = getTelegramConfig();

  // Must precede any getUpdates. A bot with a webhook still configured answers
  // every poll with 409 Conflict forever, and the poller would sit holding the
  // control lease reporting nothing useful. Legacy does this before starting
  // its poller (src/telegram-bot.js).
  await ensurePollingMode({
    token,
    migrateWebhook: getPollingConfig(env).migrateWebhook,
    callTelegram,
  });

  const identity = options.identity ?? (await resolveRuntimeIdentity(token, channelId));

  // One reference, used once. bootstrapRuntime passes this same object to both
  // the bootstrap root and RuntimeModule, and Nest keys modules by reference —
  // rebuilding it here would give the process two pools and two lease owners.
  const applicationModule = NewsAgentModule.register({ token, identity, env });

  return bootstrapRuntime({
    applicationModule,
    workerTokens: [TELEGRAM_POLLING_WORKER, NEWS_SCHEDULER_WORKER],
    ...(options.stopGracePeriodMs === undefined
      ? {}
      : { stopGracePeriodMs: options.stopGracePeriodMs }),
  });
}

/**
 * Local entry point. Deliberately not the container command: the production
 * image still runs `src/telegram-bot.js` and ships no `dist/`. Starting this
 * while the legacy runtime is also running would put two pollers on the same
 * bot, which the control lease is designed to prevent but which no one should
 * do on purpose.
 */
async function main(): Promise<void> {
  const run = await startNewsAgentRuntime();
  process.stdout.write(
    `${JSON.stringify({ event: "runtime_started", workers: ["telegram-polling", "news-scheduler"] })}\n`,
  );

  // `stopSignal.aborted` is a boolean, so awaiting it resolves immediately and
  // main() would return while the workers were still running -- leaving the
  // process alive only incidentally (the poller's handles are ref'd; the
  // scheduler's interval is unref'd), and exiting 0 on a fatal worker failure
  // so that restart policies and health-gated rollback saw a clean shutdown.
  // Wait for the actual abort event instead.
  const stopSignal = run.coordinator.stopSignal;
  if (!stopSignal.aborted) {
    await once(stopSignal, "abort");
  }
  await run.stop().catch(() => undefined);

  const fatal = run.coordinator.fatalCause;
  if (fatal !== null) {
    process.stderr.write(
      `${JSON.stringify({
        event: "runtime_stopped_fatal",
        error: fatal instanceof Error ? fatal.message : String(fatal),
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ event: "runtime_stopped" })}\n`);
}

// Only run when executed directly, so importing this module from a test does
// not start a runtime.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "runtime_start_failed",
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
