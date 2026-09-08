import { readFile } from "node:fs/promises";

import type { PipelineLeaseReadPort } from "../operations/operations.interfaces.js";
import {
  DEFAULT_RUNTIME_HEALTH_FILE,
  RUNTIME_HEALTH_SCHEMA_VERSION,
  type RuntimeHealthSnapshot,
} from "./runtime-health.js";

/** How stale a heartbeat may be before the runtime is considered wedged. */
export const DEFAULT_MAX_HEARTBEAT_AGE_MS = 45_000;
/**
 * How long a runtime may go without a completed Telegram poll and still be
 * called healthy.
 *
 * Generous next to the heartbeat, and deliberately: `getUpdates` long-polls
 * for 25 seconds, a quiet channel returns empty batches, and the backoff after
 * a transient failure reaches tens of seconds. Three minutes is well past all
 * of that and still far short of the fifteen minutes a revoked token would
 * otherwise go unnoticed.
 */
export const DEFAULT_MAX_POLL_AGE_MS = 180_000;
/** The worker whose silence this rule is about. */
const POLLING_WORKER = "telegram-polling";

export type RuntimeHealthCheckResult =
  | { healthy: true; snapshot: RuntimeHealthSnapshot }
  | { healthy: false; reason: string };

export type RuntimeHealthCheckOptions = {
  filePath?: string;
  maxHeartbeatAgeMs?: number;
  maxPollAgeMs?: number;
  leases: PipelineLeaseReadPort;
  /**
   * What this probe expects the runtime to be.
   *
   * The default readiness path is a fixed per-host constant, so two runtimes
   * sharing a filesystem namespace (staging and production on one box) would
   * clobber each other's file -- and without this, runtime A's probe would
   * confirm runtime B's lease and report A healthy. The snapshot has always
   * carried the identity; this is what compares it.
   */
  expect?: {
    botId?: number;
    channelId?: string;
    updateMode?: string;
    /** Every worker that must have started before readiness was published. */
    startedWorkers?: readonly string[];
  };
  now?: () => Date;
  /** Injected so the check can be tested without signalling a real process. */
  isProcessAlive?: (pid: number) => boolean;
  readSnapshotFile?: (path: string) => Promise<string>;
};

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseSnapshot(raw: string): RuntimeHealthSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<RuntimeHealthSnapshot>;
  const stringFields = [
    "runtimeId",
    "channelId",
    "pollerLeaseName",
    "pollerLeaseOwnerId",
    "updateMode",
    "heartbeatAt",
  ] as const;
  if (
    typeof snapshot.schemaVersion !== "number" ||
    typeof snapshot.pid !== "number" ||
    typeof snapshot.botId !== "number" ||
    (snapshot.state !== "ready" && snapshot.state !== "stopping") ||
    !Array.isArray(snapshot.startedWorkers) ||
    snapshot.startedWorkers.some((worker) => typeof worker !== "string") ||
    // Present and correctly typed, or the snapshot is not one this probe
    // understands. Accepting `undefined` here would let a runtime built before
    // this field existed report healthy without ever having polled, which is
    // the exact state the field was added to catch.
    (snapshot.lastPolledAt !== null && typeof snapshot.lastPolledAt !== "string") ||
    stringFields.some((field) => typeof snapshot[field] !== "string")
  ) {
    return null;
  }
  return snapshot as RuntimeHealthSnapshot;
}

/**
 * Decides whether the runtime holds the poller lease, rather than merely
 * running.
 *
 * The runtime's own file is treated as a *claim*, never as the answer. Every
 * check below either validates the claim's freshness or confirms it against
 * state the runtime does not control:
 *
 * 1. the file parses and matches the schema version this checker understands;
 * 2. it says `ready`, not `stopping`;
 * 2b. it describes the runtime this probe was pointed at -- identity, update
 *    mode and the workers that came up -- when the caller supplies those
 *    expectations, checked before the database is touched, so a probe never
 *    confirms a lease it was not asked about;
 * 3. its heartbeat is recent — a wedged process stops advancing it;
 * 4. the pid it names is actually alive — a stale file from a crashed run
 *    would otherwise pass every check above;
 * 5. the database is reachable, and the poller lease row genuinely names this
 *    runtime's owner id and has not expired -- judged against PostgreSQL's own
 *    clock, read in the same statement, so a skewed probe container cannot
 *    declare a healthy lease expired.
 *
 * Step 5 is what makes this meaningful. The current container check passes
 * while a duplicate poller waits out its 70-second lease-acquire timeout and
 * is about to fail; this reports unhealthy for that case, because the lease is
 * owned by somebody else.
 */
export async function checkRuntimeHealth(
  options: RuntimeHealthCheckOptions,
): Promise<RuntimeHealthCheckResult> {
  const filePath = options.filePath ?? DEFAULT_RUNTIME_HEALTH_FILE;
  const maxAge = options.maxHeartbeatAgeMs ?? DEFAULT_MAX_HEARTBEAT_AGE_MS;
  const now = options.now ?? (() => new Date());
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const read = options.readSnapshotFile ?? ((path: string) => readFile(path, "utf8"));

  let raw: string;
  try {
    raw = await read(filePath);
  } catch {
    return { healthy: false, reason: `no readiness file at ${filePath}` };
  }

  const snapshot = parseSnapshot(raw);
  if (snapshot === null) {
    return { healthy: false, reason: "readiness file is malformed" };
  }
  if (snapshot.schemaVersion !== RUNTIME_HEALTH_SCHEMA_VERSION) {
    return {
      healthy: false,
      reason: `readiness file schema ${snapshot.schemaVersion} is not ${RUNTIME_HEALTH_SCHEMA_VERSION}`,
    };
  }
  if (snapshot.state !== "ready") {
    return { healthy: false, reason: `runtime reports state ${snapshot.state}` };
  }

  const expected = options.expect;
  if (expected?.botId !== undefined && snapshot.botId !== expected.botId) {
    return {
      healthy: false,
      reason: `readiness file belongs to bot ${snapshot.botId}, not ${expected.botId}`,
    };
  }
  if (expected?.channelId !== undefined && snapshot.channelId !== expected.channelId) {
    return {
      healthy: false,
      reason: `readiness file belongs to channel ${snapshot.channelId}, not ${expected.channelId}`,
    };
  }

  const heartbeatAt = Date.parse(snapshot.heartbeatAt);
  if (Number.isNaN(heartbeatAt)) {
    return { healthy: false, reason: "readiness heartbeat timestamp is unparseable" };
  }
  const age = now().valueOf() - heartbeatAt;
  if (age > maxAge) {
    return { healthy: false, reason: `readiness heartbeat is ${age}ms old, over ${maxAge}ms` };
  }

  // A runtime that is up but not serving.
  //
  // The heartbeat above proves the process is alive; it says nothing about
  // whether Telegram is answering. A permanently failing `getUpdates` -- a
  // revoked token, a lasting partition -- backs off and retries forever
  // without surrendering the lease, so every condition checked so far holds
  // while the bot is deaf. This is the condition that separates them.
  //
  // Only asked of a runtime that started the poller: a reduced worker set is
  // refused below, on its own terms, and asking a runtime without a poller to
  // have polled would report the wrong fault.
  if (snapshot.startedWorkers.includes(POLLING_WORKER)) {
    const maxPollAge = options.maxPollAgeMs ?? DEFAULT_MAX_POLL_AGE_MS;
    if (!snapshot.lastPolledAt) {
      return { healthy: false, reason: "the poller has not completed a poll yet" };
    }
    const polledAt = Date.parse(snapshot.lastPolledAt);
    if (Number.isNaN(polledAt)) {
      return { healthy: false, reason: "last poll timestamp is unparseable" };
    }
    const pollAge = now().valueOf() - polledAt;
    if (pollAge > maxPollAge) {
      return {
        healthy: false,
        reason: `the last completed poll is ${pollAge}ms old, over ${maxPollAge}ms`,
      };
    }
  }

  if (expected?.updateMode !== undefined && snapshot.updateMode !== expected.updateMode) {
    return {
      healthy: false,
      reason: `runtime is in ${snapshot.updateMode} mode, not ${expected.updateMode}`,
    };
  }
  const missingWorkers = (expected?.startedWorkers ?? []).filter(
    (worker) => !snapshot.startedWorkers.includes(worker),
  );
  if (missingWorkers.length > 0) {
    // A runtime that came up without its scheduler polls fine and serves no
    // scheduled run. Start order alone cannot express that: the health worker
    // is last either way.
    return {
      healthy: false,
      reason: `runtime started without ${missingWorkers.join(", ")}`,
    };
  }

  if (!isProcessAlive(snapshot.pid)) {
    return { healthy: false, reason: `process ${snapshot.pid} is not running` };
  }

  let lease;
  try {
    lease = await options.leases.readPipelineLease(snapshot.pollerLeaseName);
  } catch (error) {
    return {
      healthy: false,
      reason: `database is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (lease === null) {
    return { healthy: false, reason: `poller lease ${snapshot.pollerLeaseName} is not held` };
  }
  if (lease.ownerId !== snapshot.pollerLeaseOwnerId) {
    return {
      healthy: false,
      reason: `poller lease is owned by another runtime (${lease.ownerId})`,
    };
  }
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.serverNowAt)) {
    return { healthy: false, reason: `poller lease expired at ${lease.expiresAt}` };
  }

  return { healthy: true, snapshot };
}
