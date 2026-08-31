import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PipelineLeaseReadPort } from "../../src/operations/operations.interfaces.js";
import {
  checkRuntimeHealth,
  DEFAULT_MAX_HEARTBEAT_AGE_MS,
} from "../../src/runtime/runtime-health-check.js";
import {
  RUNTIME_HEALTH_SCHEMA_VERSION,
  RuntimeHealthWorker,
  type RuntimeHealthSnapshot,
} from "../../src/runtime/runtime-health.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runtime-health-"));
  return join(directory, "health.json");
}

function worker(filePath: string, overrides: Record<string, unknown> = {}) {
  return new RuntimeHealthWorker({
    runtimeId: "runtime-1",
    botId: 4242,
    channelId: "@channel",
    pollerLeaseName: "telegram_control_poller",
    pollerLeaseOwnerId: "owner-1",
    filePath,
    now: () => NOW,
    ...overrides,
  });
}

/** A lease the checker will accept, unless a test overrides a field. */
function leaseReader(
  snapshot: Partial<{ ownerId: string; expiresAt: string }> | null,
  onRead?: (name: string) => void,
): PipelineLeaseReadPort {
  return {
    async readPipelineLease(name) {
      onRead?.(name);
      if (snapshot === null) return null;
      return {
        name,
        ownerId: snapshot.ownerId ?? "owner-1",
        acquiredAt: "2026-08-31T11:59:00.000Z",
        expiresAt: snapshot.expiresAt ?? "2026-08-31T12:01:00.000Z",
      };
    },
  };
}

async function readySnapshot(): Promise<{ filePath: string }> {
  const filePath = await temporaryFile();
  const health = worker(filePath);
  await health.start(new AbortController().signal);
  return { filePath };
}

test("start publishes a ready snapshot the checker's schema accepts, readable only by its owner", async () => {
  const { filePath } = await readySnapshot();

  const snapshot = JSON.parse(await readFile(filePath, "utf8")) as RuntimeHealthSnapshot;
  assert.equal(snapshot.schemaVersion, RUNTIME_HEALTH_SCHEMA_VERSION);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.runtimeId, "runtime-1");
  assert.equal(snapshot.pollerLeaseOwnerId, "owner-1");
  assert.equal(snapshot.heartbeatAt, NOW.toISOString());
  assert.equal(snapshot.pid, process.pid);

  // The file names the lease owner, so it must not be world-readable.
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("stop removes the readiness file, and is idempotent", async () => {
  const filePath = await temporaryFile();
  const health = worker(filePath);
  await health.start(new AbortController().signal);
  assert.ok(await readFile(filePath, "utf8"));

  await health.stop();
  // Gone, so a checker cannot read a stale "ready" from a runtime that has
  // already drained. The "stopping" snapshot published just before the unlink
  // covers the window where a reader catches the file mid-teardown; the test
  // below proves the checker rejects that state.
  await assert.rejects(readFile(filePath, "utf8"), /ENOENT/);

  // Called again by the coordinator during an escalated shutdown: must not
  // throw on the already-missing file.
  await health.stop();
});

test("a stopping snapshot is reported unhealthy rather than ready", async () => {
  const filePath = await temporaryFile();
  const health = worker(filePath);
  await health.start(new AbortController().signal);
  const raw = await readFile(filePath, "utf8");
  const stopping = JSON.stringify({ ...JSON.parse(raw), state: "stopping" });

  const result = await checkRuntimeHealth({
    filePath,
    leases: leaseReader({}),
    now: () => NOW,
    isProcessAlive: () => true,
    readSnapshotFile: async () => stopping,
  });
  assert.equal(result.healthy, false);
  assert.match(result.healthy ? "" : result.reason, /state stopping/);
});

test("the heartbeat keeps advancing the published timestamp", async () => {
  const filePath = await temporaryFile();
  let clock = NOW.valueOf();
  const health = worker(filePath, {
    now: () => new Date(clock),
    heartbeatIntervalMs: 5,
  });
  await health.start(new AbortController().signal);
  const first = JSON.parse(await readFile(filePath, "utf8")) as RuntimeHealthSnapshot;

  clock += 60_000;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = JSON.parse(await readFile(filePath, "utf8")) as RuntimeHealthSnapshot;
  await health.stop();

  assert.notEqual(second.heartbeatAt, first.heartbeatAt);
  assert.equal(second.heartbeatAt, new Date(clock).toISOString());
});

test("a healthy runtime passes, and the checker confirms the lease it was told about", async () => {
  const { filePath } = await readySnapshot();
  const namesRead: string[] = [];

  const result = await checkRuntimeHealth({
    filePath,
    leases: leaseReader({}, (name) => namesRead.push(name)),
    now: () => NOW,
    isProcessAlive: () => true,
  });

  assert.equal(result.healthy, true);
  // Not a hardcoded lease name: the checker looks up the lease the snapshot
  // names, so a runtime on a different lease is checked against that lease.
  assert.deepEqual(namesRead, ["telegram_control_poller"]);
});

test("a missing or malformed readiness file is unhealthy, never an exception", async () => {
  const absent = await checkRuntimeHealth({
    filePath: join(tmpdir(), "runtime-health-does-not-exist.json"),
    leases: leaseReader({}),
    now: () => NOW,
  });
  assert.equal(absent.healthy, false);
  assert.match(absent.healthy ? "" : absent.reason, /no readiness file/);

  const malformed = await checkRuntimeHealth({
    filePath: "ignored",
    leases: leaseReader({}),
    now: () => NOW,
    readSnapshotFile: async () => "{ not json",
  });
  assert.equal(malformed.healthy, false);
  assert.match(malformed.healthy ? "" : malformed.reason, /malformed/);

  // A future runtime writing a schema this checker does not understand must be
  // reported unhealthy rather than interpreted optimistically.
  const futureSchema = await checkRuntimeHealth({
    filePath: "ignored",
    leases: leaseReader({}),
    now: () => NOW,
    readSnapshotFile: async () =>
      JSON.stringify({
        schemaVersion: RUNTIME_HEALTH_SCHEMA_VERSION + 1,
        runtimeId: "runtime-1",
        pid: 1,
        botId: 1,
        channelId: "@c",
        pollerLeaseName: "l",
        pollerLeaseOwnerId: "o",
        state: "ready",
        heartbeatAt: NOW.toISOString(),
      }),
  });
  assert.equal(futureSchema.healthy, false);
  assert.match(futureSchema.healthy ? "" : futureSchema.reason, /schema/);
});

test("a wedged runtime fails on heartbeat age even though its file still says ready", async () => {
  const { filePath } = await readySnapshot();
  const result = await checkRuntimeHealth({
    filePath,
    leases: leaseReader({}),
    isProcessAlive: () => true,
    now: () => new Date(NOW.valueOf() + DEFAULT_MAX_HEARTBEAT_AGE_MS + 1),
  });
  assert.equal(result.healthy, false);
  assert.match(result.healthy ? "" : result.reason, /heartbeat is \d+ms old/);
});

test("a stale file from a crashed runtime fails on the pid check", async () => {
  const { filePath } = await readySnapshot();
  const result = await checkRuntimeHealth({
    filePath,
    leases: leaseReader({}),
    now: () => NOW,
    isProcessAlive: () => false,
  });
  assert.equal(result.healthy, false);
  assert.match(result.healthy ? "" : result.reason, /is not running/);
});

test("a duplicate runtime that has not won the lease is unhealthy, which is the whole point", async () => {
  // This is the case the container's current process-alive check gets wrong: a
  // second poller is up, its file says ready, its pid is alive, its heartbeat
  // is fresh -- and it is serving nothing, because another process owns the
  // lease. Only the database can tell the two apart.
  const { filePath } = await readySnapshot();

  const notHeld = await checkRuntimeHealth({
    filePath,
    leases: leaseReader(null),
    now: () => NOW,
    isProcessAlive: () => true,
  });
  assert.equal(notHeld.healthy, false);
  assert.match(notHeld.healthy ? "" : notHeld.reason, /is not held/);

  const heldByOther = await checkRuntimeHealth({
    filePath,
    leases: leaseReader({ ownerId: "somebody-else" }),
    now: () => NOW,
    isProcessAlive: () => true,
  });
  assert.equal(heldByOther.healthy, false);
  assert.match(heldByOther.healthy ? "" : heldByOther.reason, /owned by another runtime/);

  const expired = await checkRuntimeHealth({
    filePath,
    leases: leaseReader({ expiresAt: NOW.toISOString() }),
    now: () => NOW,
    isProcessAlive: () => true,
  });
  assert.equal(expired.healthy, false);
  assert.match(expired.healthy ? "" : expired.reason, /expired/);
});

test("an unreachable database is unhealthy, not a thrown probe", async () => {
  const { filePath } = await readySnapshot();
  const result = await checkRuntimeHealth({
    filePath,
    now: () => NOW,
    isProcessAlive: () => true,
    leases: {
      async readPipelineLease() {
        throw new Error("connection refused");
      },
    },
  });
  assert.equal(result.healthy, false);
  assert.match(result.healthy ? "" : result.reason, /database is unreachable/);
});
