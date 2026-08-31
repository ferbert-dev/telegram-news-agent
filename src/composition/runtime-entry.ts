import "reflect-metadata";

import { once } from "node:events";
import { pathToFileURL } from "node:url";

import { callTelegram, getTelegramConfig } from "../telegram.js";
import { ensurePollingMode, getPollingConfig } from "../telegram-polling.js";
import type { DynamicModule } from "@nestjs/common";

import { bootstrapRuntime, type RuntimeBootstrapRun } from "../runtime/runtime-bootstrap.js";
import {
  NEWS_SCHEDULER_WORKER,
  NewsAgentModule,
  RUNTIME_HEALTH_WORKER,
  startedWorkerNames,
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
 * The worker start order, which is the readiness contract rather than a
 * preference.
 *
 * The Telegram poller must own its lease before the scheduler begins, so it
 * comes first. The health worker must come LAST: the coordinator starts in
 * this order and calls stop in reverse, so being last is what makes the
 * readiness file mean "the poller owns its lease" rather than "a process
 * started". Moved to the front, it would publish "ready" during the poller's
 * 70-second lease-acquire wait -- reinstating exactly the duplicate-poller
 * false-healthy this protocol exists to catch.
 *
 * Exported as a constant so that ordering is a testable fact and not a comment.
 */
/** The only mode getPollingConfig accepts, and so the only one a runtime runs in. */
export const VALIDATED_UPDATE_MODE = "polling";

export const RUNTIME_WORKER_TOKENS = [
  TELEGRAM_POLLING_WORKER,
  NEWS_SCHEDULER_WORKER,
  RUNTIME_HEALTH_WORKER,
] as const;

/**
 * Builds the composition root and starts every worker.
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
  // Throws unless TELEGRAM_UPDATE_MODE is exactly "polling", so everything
  // below runs in a validated mode -- which is what the readiness file records.
  const { migrateWebhook } = getPollingConfig(env);
  await ensurePollingMode({ token, migrateWebhook, callTelegram });
  // getPollingConfig has now proven this; passing the proven value rather than
  // a literal keeps composeRuntime from recording a mode nothing checked when
  // it is called directly.
  const updateMode = VALIDATED_UPDATE_MODE;

  const identity = options.identity ?? (await resolveRuntimeIdentity(token, channelId));

  // One reference, used once. bootstrapRuntime passes this same object to both
  // the bootstrap root and RuntimeModule, and Nest keys modules by reference —
  // rebuilding it here would give the process two pools and two lease owners.
  return bootstrapRuntime({
    ...composeRuntime({
      token,
      identity,
      env,
      updateMode,
      workerTokens: [...RUNTIME_WORKER_TOKENS],
    }),
    ...(options.stopGracePeriodMs === undefined
      ? {}
      : { stopGracePeriodMs: options.stopGracePeriodMs }),
  });
}

/**
 * Builds the module and the worker-token list together, from one list.
 *
 * Separated from `startNewsAgentRuntime` because that function cannot run in a
 * test -- it calls Telegram twice before it composes anything. The invariant
 * worth pinning is exactly what this function guarantees: the readiness file
 * describes the tokens the runtime is about to start, so a filtered or
 * conditional token list changes the file rather than being contradicted by it.
 */
export function composeRuntime(options: {
  token: string;
  identity: NewsAgentRuntimeIdentity;
  env: NodeJS.ProcessEnv;
  /** The mode the caller validated. No default: a literal here could lie. */
  updateMode: string;
  workerTokens: readonly symbol[];
}): { applicationModule: DynamicModule; workerTokens: symbol[] } {
  const workerTokens = [...options.workerTokens];
  return {
    applicationModule: NewsAgentModule.register({
      token: options.token,
      identity: options.identity,
      env: options.env,
      updateMode: options.updateMode,
      startedWorkers: startedWorkerNames(workerTokens),
    }),
    workerTokens,
  };
}

/**
 * Local entry point. The image ships `dist/`, but does not start it: `CMD` and
 * `compose.yaml` both still run `src/telegram-bot.js`, and no deployment path
 * passes the `compose.nest.yaml` overlay that would run this instead. Starting
 * this while the legacy runtime is also running would put two pollers on the
 * same bot, which the control lease is designed to prevent but which no one
 * should do on purpose.
 */
async function main(): Promise<void> {
  const run = await startNewsAgentRuntime();
  process.stdout.write(
    `${JSON.stringify({ event: "runtime_started", workers: ["telegram-polling", "news-scheduler", "runtime-health"] })}\n`,
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
