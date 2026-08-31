import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  snapshot: Partial<{ ownerId: string; expiresAt: string; serverNowAt: string }> | null,
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
        serverNowAt: snapshot.serverNowAt ?? NOW.toISOString(),
      };
    },
  };
}

const started: RuntimeHealthWorker[] = [];

/** Publishes a ready snapshot and registers the worker for teardown. */
async function readySnapshot(): Promise<{ filePath: string }> {
  const filePath = await temporaryFile();
  const health = worker(filePath);
  started.push(health);
  await health.start(new AbortController().signal);
  return { filePath };
}

test.after(async () => {
  // Otherwise every started worker leaves a live (unref'd) heartbeat behind for
  // the rest of the run.
  await Promise.all(started.map((health) => health.stop()));
});

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

test("a heartbeat landing during stop cannot leave a ready file behind", async () => {
  // The failure this guards: clearInterval cannot cancel a heartbeat whose
  // write is already in flight. With publishes racing on one temp path, one
  // rename lost with ENOENT, the unlink was skipped, and the readiness file
  // survived the drain -- sometimes still saying "ready". A probe arriving in
  // the 45s shutdown window would then report healthy for a runtime on its way
  // out, with a live pid, a fresh heartbeat and a lease not yet released.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const filePath = await temporaryFile();
    const health = worker(filePath, { heartbeatIntervalMs: 1 });
    await health.start(new AbortController().signal);
    // Land squarely in the middle of a heartbeat tick.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await health.stop();

    await assert.rejects(
      readFile(filePath, "utf8"),
      /ENOENT/,
      `attempt ${attempt}: readiness file survived stop()`,
    );
    // And no temp file left orphaned in the directory either.
    const leftovers = await readdir(dirname(filePath));
    assert.deepEqual(leftovers, [], `attempt ${attempt}: ${leftovers.join(", ")}`);
  }
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

test("lease expiry is judged on PostgreSQL's clock, so a skewed probe host is not a restart loop", async () => {
  // The renewal margin is 40s (20s renew against a 60s TTL). If expiry were
  // compared against the probe's own clock, a host running two minutes fast
  // would report a perfectly healthy runtime as expired on every single probe.
  // Here the runtime and the probe share a clock two minutes ahead of the
  // database, so the heartbeat is fresh and only the lease comparison is at
  // issue.
  const skewed = new Date(NOW.valueOf() + 120_000);
  const filePath = await temporaryFile();
  const health = worker(filePath, { now: () => skewed });
  started.push(health);
  await health.start(new AbortController().signal);

  const result = await checkRuntimeHealth({
    filePath,
    leases: leaseReader({
      // Issued by the database a minute before its own now: still valid there.
      expiresAt: "2026-08-31T12:01:00.000Z",
      serverNowAt: NOW.toISOString(),
    }),
    now: () => skewed,
    isProcessAlive: () => true,
  });

  assert.equal(result.healthy, true);
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

test("a readiness file written by a different runtime is rejected, not confirmed", async () => {
  // Two runtimes sharing a filesystem namespace clobber the default path. The
  // snapshot has always carried the identity; without comparing it, this
  // probe would go on to confirm the *other* runtime's lease and report the
  // wrong one healthy.
  const { filePath } = await readySnapshot();
  let reachedDatabase = false;

  const result = await checkRuntimeHealth({
    filePath,
    expect: { channelId: "@a-different-channel" },
    now: () => NOW,
    isProcessAlive: () => true,
    leases: leaseReader({}, () => {
      reachedDatabase = true;
    }),
  });

  assert.equal(result.healthy, false);
  assert.match(result.healthy ? "" : result.reason, /belongs to channel @channel/);
  assert.equal(reachedDatabase, false, "must not confirm a lease it was not asked about");

  // The matching identity still passes, so this is a mismatch check and not a
  // blanket refusal.
  const matching = await checkRuntimeHealth({
    filePath,
    expect: { channelId: "@channel", botId: 4242 },
    now: () => NOW,
    isProcessAlive: () => true,
    leases: leaseReader({}),
  });
  assert.equal(matching.healthy, true);
});

test("a worker that never published does not delete somebody else's readiness file", async () => {
  // Two runtimes share the default path. If B aborts during startup -- a bad
  // token, a failed ensurePollingMode -- its health worker's stop() must not
  // touch the file, or A's probe reads "no readiness file" and a healthy
  // runtime gets restarted.
  const { filePath } = await readySnapshot();
  const owned = await readFile(filePath, "utf8");

  const aborted = new AbortController();
  aborted.abort();
  const neverStarted = worker(filePath, { runtimeId: "runtime-2" });
  await neverStarted.start(aborted.signal);
  await neverStarted.stop();

  assert.equal(await readFile(filePath, "utf8"), owned);
});

test("a stop landing during start does not leave an uncancellable heartbeat", async () => {
  const filePath = await temporaryFile();
  const health = worker(filePath, { heartbeatIntervalMs: 1 });

  // stop() while the first publish is still in flight: it finds no interval to
  // clear, so start() must not go on to create one.
  const starting = health.start(new AbortController().signal);
  const stopping = health.stop();
  await Promise.all([starting, stopping]);

  const internals = health as unknown as { heartbeat: NodeJS.Timeout | null };
  assert.equal(internals.heartbeat, null);
  await assert.rejects(readFile(filePath, "utf8"), /ENOENT/);
});

test("a second concurrent stop waits for the first rather than reporting done early", async () => {
  const filePath = await temporaryFile();
  const health = worker(filePath);
  await health.start(new AbortController().signal);

  const [first, second] = [health.stop(), health.stop()];
  // The coordinator can call stop twice during an escalated shutdown. If the
  // second returned immediately it would report teardown complete while the
  // file was still on disk.
  await second;
  await assert.rejects(readFile(filePath, "utf8"), /ENOENT/);
  await first;
});

test("a failed publish leaves no orphaned temp file behind", async () => {
  // The temp suffix is unique per attempt, so cleanup that only covered part
  // of the write would leak a new file every heartbeat until /tmp filled.
  // A directory at the target makes the rename fail after the temp file exists.
  const filePath = await temporaryFile();
  await mkdir(filePath);
  const health = worker(filePath, { heartbeatIntervalMs: 5 });

  await assert.rejects(health.start(new AbortController().signal));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await health.stop().catch(() => undefined);

  // Only the directory itself: no `health.json.<pid>.<n>.tmp` survivors.
  assert.deepEqual(await readdir(dirname(filePath)), ["health.json"]);
  assert.deepEqual(await readdir(filePath), []);
});
