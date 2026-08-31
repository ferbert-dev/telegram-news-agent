import { readFile } from "node:fs/promises";

import type { PipelineLeaseReadPort } from "../operations/operations.interfaces.js";
import {
  DEFAULT_RUNTIME_HEALTH_FILE,
  RUNTIME_HEALTH_SCHEMA_VERSION,
  type RuntimeHealthSnapshot,
} from "./runtime-health.js";

/** How stale a heartbeat may be before the runtime is considered wedged. */
export const DEFAULT_MAX_HEARTBEAT_AGE_MS = 45_000;

export type RuntimeHealthCheckResult =
  | { healthy: true; snapshot: RuntimeHealthSnapshot }
  | { healthy: false; reason: string };

export type RuntimeHealthCheckOptions = {
  filePath?: string;
  maxHeartbeatAgeMs?: number;
  leases: PipelineLeaseReadPort;
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
  const stringFields = ["runtimeId", "channelId", "pollerLeaseName", "pollerLeaseOwnerId", "heartbeatAt"] as const;
  if (
    typeof snapshot.schemaVersion !== "number" ||
    typeof snapshot.pid !== "number" ||
    typeof snapshot.botId !== "number" ||
    (snapshot.state !== "ready" && snapshot.state !== "stopping") ||
    stringFields.some((field) => typeof snapshot[field] !== "string")
  ) {
    return null;
  }
  return snapshot as RuntimeHealthSnapshot;
}

/**
 * Decides whether the runtime is genuinely serving, not merely running.
 *
 * The runtime's own file is treated as a *claim*, never as the answer. Every
 * check below either validates the claim's freshness or confirms it against
 * state the runtime does not control:
 *
 * 1. the file parses and matches the schema version this checker understands;
 * 2. it says `ready`, not `stopping`;
 * 3. its heartbeat is recent — a wedged process stops advancing it;
 * 4. the pid it names is actually alive — a stale file from a crashed run
 *    would otherwise pass every check above;
 * 5. the database is reachable, and the poller lease row genuinely names this
 *    runtime's owner id and has not expired.
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

  const heartbeatAt = Date.parse(snapshot.heartbeatAt);
  if (Number.isNaN(heartbeatAt)) {
    return { healthy: false, reason: "readiness heartbeat timestamp is unparseable" };
  }
  const age = now().valueOf() - heartbeatAt;
  if (age > maxAge) {
    return { healthy: false, reason: `readiness heartbeat is ${age}ms old, over ${maxAge}ms` };
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
  if (Date.parse(lease.expiresAt) <= now().valueOf()) {
    return { healthy: false, reason: `poller lease expired at ${lease.expiresAt}` };
  }

  return { healthy: true, snapshot };
}
