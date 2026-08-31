import "reflect-metadata";

import { pathToFileURL } from "node:url";

import { createRuntimeApplicationContext } from "../runtime/runtime-bootstrap.js";
import { checkRuntimeHealth } from "../runtime/runtime-health-check.js";
import { DatabaseModule } from "../database/database.module.js";
import { OperationsPersistenceModule } from "../operations/operations-persistence.module.js";
import { PIPELINE_LEASES_REPOSITORY } from "../operations/operations.tokens.js";
import type { PipelineLeaseReadPort } from "../operations/operations.interfaces.js";

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
  // Read directly rather than through getTelegramConfig, which throws on an
  // incomplete environment: a probe should report unhealthy, never crash. The
  // channel is optional here for the same reason -- when it is absent the
  // identity comparison is simply skipped.
  const channelId = env.TELEGRAM_CHANNEL_ID;
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
      ...(channelId ? { expect: { channelId } } : {}),
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
