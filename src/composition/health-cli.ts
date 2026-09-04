import "reflect-metadata";

import { pathToFileURL } from "node:url";

import { createRuntimeApplicationContext } from "../runtime/runtime-bootstrap.js";
import { checkRuntimeHealth } from "../runtime/runtime-health-check.js";
import { DatabaseModule } from "../database/database.module.js";
import { OperationsPersistenceModule } from "../operations/operations-persistence.module.js";
import { PIPELINE_LEASES_REPOSITORY } from "../operations/operations.tokens.js";

import type { PipelineLeaseReadPort } from "../operations/operations.interfaces.js";

/** What a healthy deployment must be running, independent of what it started. */
export const REQUIRED_WORKERS = [
  "telegram-polling",
  "news-scheduler",
  // Required, not optional. A runtime without it answers `/news` with
  // "Research queued" and then never researches anything, and because the
  // enqueue function allows one active job per channel, that one dead job
  // suppresses every later `/news` on the channel. A deployment in that state
  // looks healthy on every other signal, which is precisely why it belongs in
  // the probe's required set.
  "telegram-news-jobs",
] as const;

/**
 * The identity this probe expects the runtime to have.
 *
 * Read directly rather than through `getTelegramConfig`, which throws on an
 * incomplete environment: a probe should report unhealthy, never crash. The
 * value is trimmed because `getTelegramConfig` trims before the runtime writes
 * it into the snapshot -- comparing a raw value against a trimmed one turns a
 * trailing space or a CRLF in `.env` into "belongs to channel @x, not @x ", a
 * visually identical mismatch that would fail every probe on a working bot.
 */
export function expectedIdentity(
  env: NodeJS.ProcessEnv,
): { channelId: string; updateMode: string; startedWorkers: readonly string[] } | null {
  const channelId = env.TELEGRAM_CHANNEL_ID?.trim();
  return channelId
    ? {
        channelId,
        // The runtime refuses to start in any other mode, so a snapshot saying
        // otherwise means the file belongs to something else.
        updateMode: "polling",
        // Declared here deliberately, and NOT imported from the composition
        // root: this is what a healthy deployment must be running, which is a
        // different statement from what some runtime happened to start. Sharing
        // one constant between the writer and the probe would compare it to
        // itself and could never fail.
        startedWorkers: REQUIRED_WORKERS,
      }
    : null;
}

/**
 * A separate process from the runtime it is checking. That separation is the
 * point: a runtime cannot report itself healthy, because this reads the
 * readiness file as a *claim* and then confirms it against the database
 * independently.
 *
 * Only the database is booted here — no workers, no Telegram, no AI provider —
 * so the check cannot acquire a lease, send a message, or spend a token.
 */
export async function runHealthCli(
  filePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ healthy: boolean; reason?: string }> {
  const expect = expectedIdentity(env);
  // Fail closed. Skipping the identity comparison when the variable is missing
  // would drop the guard in precisely the misconfigured case where two
  // runtimes end up sharing the default readiness path -- and this probe would
  // then confirm the neighbour's lease and report the wrong runtime healthy.
  if (expect === null) {
    return {
      healthy: false,
      reason: "TELEGRAM_CHANNEL_ID is not set, so the runtime cannot be identified",
    };
  }
  const application = await createRuntimeApplicationContext({
    module: class HealthCliModule {},
    imports: [DatabaseModule, OperationsPersistenceModule],
  });
  try {
    const leases = application.get<PipelineLeaseReadPort>(PIPELINE_LEASES_REPOSITORY, {
      strict: false,
    });
    const result = await checkRuntimeHealth({
      leases,
      ...(filePath ? { filePath } : {}),
      expect,
    });
    return result.healthy ? { healthy: true } : { healthy: false, reason: result.reason };
  } finally {
    // Always close, so a health probe never leaks a pool connection. Compose
    // runs this on an interval; leaking here would exhaust the pool.
    await application.close();
  }
}

async function main(): Promise<void> {
  const result = await runHealthCli(process.argv[2]);
  if (result.healthy) {
    process.stdout.write(`${JSON.stringify({ event: "runtime_healthy" })}\n`);
    return;
  }
  process.stderr.write(
    `${JSON.stringify({ event: "runtime_unhealthy", reason: result.reason })}\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "runtime_health_check_failed",
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
