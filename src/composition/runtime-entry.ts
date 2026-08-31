import "reflect-metadata";

import { callTelegram, getTelegramConfig } from "../telegram.js";
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
  const { token, channelId } = getTelegramConfig();
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
  await run.coordinator.stopSignal.aborted;
}

// Only run when executed directly, so importing this module from a test does
// not start a runtime.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
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
