import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";

import type { RuntimeWorker } from "./runtime-coordinator.js";

export const RUNTIME_HEALTH_SCHEMA_VERSION = 1;
export const DEFAULT_RUNTIME_HEALTH_FILE = "/tmp/telegram-news-agent-runtime-health.json";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export type RuntimeHealthSnapshot = {
  schemaVersion: number;
  runtimeId: string;
  pid: number;
  botId: number;
  channelId: string;
  pollerLeaseName: string;
  pollerLeaseOwnerId: string;
  state: "ready" | "stopping";
  heartbeatAt: string;
};

export type RuntimeHealthWorkerOptions = {
  runtimeId: string;
  botId: number;
  channelId: string;
  pollerLeaseName: string;
  pollerLeaseOwnerId: string;
  filePath?: string;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  pid?: number;
  log?: { warn?: (message: string) => void };
};

/**
 * Publishes a readiness snapshot other processes can check.
 *
 * Registered as the LAST runtime worker on purpose. The coordinator starts
 * workers in order and calls stop in reverse, so being last means this only
 * reports ready once the poller owns its lease and the scheduler is running,
 * and its `stop()` is the first one called — the stopping snapshot is
 * published at the start of the drain rather than after it. (The stops are
 * invoked in reverse order but run concurrently, so this does not mean the
 * poller has finished draining; it means a probe arriving during the drain
 * reads "stopping" rather than a stale "ready".)
 *
 * Process-alive is not readiness: a bare process check passes while a
 * duplicate poller sits in its 70-second lease-acquire timeout and is about to
 * fail. The file this writes is only half the answer — it carries the claim,
 * and the health CLI verifies that claim against the database. A runtime
 * cannot mark itself healthy by writing a file, because the checker
 * independently confirms the lease row actually names this runtime's owner id
 * and has not expired.
 *
 * The heartbeat is this worker's own timer and says nothing about the poll
 * loop: a runtime whose `getUpdates` fails permanently keeps ticking here. See
 * `runtime-health-check.ts` for what a healthy result does and does not prove.
 *
 * The file is written temp-then-rename so a reader never observes a partial
 * document, and chmod 0600 because it names the lease owner.
 */
export class RuntimeHealthWorker implements RuntimeWorker {
  readonly name = "runtime-health";

  private readonly options: Required<
    Pick<RuntimeHealthWorkerOptions, "filePath" | "heartbeatIntervalMs" | "now" | "pid">
  > &
    RuntimeHealthWorkerOptions;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;
  /**
   * Publishes are serialized through this chain. Two concurrent publishes used
   * to race on one temp path: `clearInterval` cannot cancel a heartbeat whose
   * write is already in flight, so a tick landing during `stop()` would fight
   * the stopping snapshot, one `rename` would fail with ENOENT, and the
   * readiness file could be left behind still saying "ready" — reported
   * healthy for a runtime that is shutting down, which is exactly what the
   * stopping state exists to prevent.
   */
  private publishing: Promise<void> = Promise.resolve();
  private publishSequence = 0;
  /**
   * Whether this worker has ever published. `stop()` must not touch the file
   * otherwise: a runtime that aborts during startup would delete the readiness
   * file of a *different* runtime sharing the default path, and that runtime's
   * probe would then read "no readiness file" and restart a healthy process.
   */
  private published = false;
  /** Memoized so a concurrent second stop() awaits the first rather than
   * reporting teardown complete while the file is still on disk. */
  private stopPromise: Promise<void> | null = null;

  constructor(options: RuntimeHealthWorkerOptions) {
    this.options = {
      ...options,
      filePath: options.filePath ?? DEFAULT_RUNTIME_HEALTH_FILE,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      now: options.now ?? (() => new Date()),
      pid: options.pid ?? process.pid,
    };
  }

  snapshot(state: RuntimeHealthSnapshot["state"]): RuntimeHealthSnapshot {
    return {
      schemaVersion: RUNTIME_HEALTH_SCHEMA_VERSION,
      runtimeId: this.options.runtimeId,
      pid: this.options.pid,
      botId: this.options.botId,
      channelId: this.options.channelId,
      pollerLeaseName: this.options.pollerLeaseName,
      pollerLeaseOwnerId: this.options.pollerLeaseOwnerId,
      state,
      heartbeatAt: this.options.now().toISOString(),
    };
  }

  private publish(state: RuntimeHealthSnapshot["state"]): Promise<void> {
    // Chained off the settled tail so a failed publish does not wedge the
    // queue; `publishing` never rejects, so only the success arm is needed.
    const next = this.publishing.then(() => this.write(state));
    this.publishing = next.catch(() => undefined);
    return next;
  }

  private async write(state: RuntimeHealthSnapshot["state"]): Promise<void> {
    const target = this.options.filePath;
    // Same directory, so the rename is atomic rather than a cross-device copy.
    // The sequence number keeps two publishes from ever sharing a temp path.
    const temporary = `${target}.${this.options.pid}.${(this.publishSequence += 1)}.tmp`;
    try {
      // Narrow at creation rather than after: a chmod that follows the write
      // leaves the snapshot briefly readable at the default umask, and it names
      // the lease owner.
      await writeFile(temporary, `${JSON.stringify(this.snapshot(state))}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } catch (error) {
      // The whole write, not just the rename: a writeFile that fails after
      // creating the file (ENOSPC) or a failing chmod would otherwise orphan a
      // temp file -- and since the suffix is unique per attempt, a 10s
      // heartbeat would leave a new one behind every tick until /tmp filled.
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    this.published = true;
  }

  async start(shutdownSignal: AbortSignal): Promise<void> {
    if (this.stopped || shutdownSignal.aborted) return;
    // Tolerated rather than thrown, for the same reason a failed heartbeat is:
    // this is the least important worker, and letting it veto startup would
    // take down a poller and scheduler that can serve perfectly well. A
    // readiness file that never appears already reports unhealthy, which is
    // the correct signal -- the compose filesystem is read_only with a 32m
    // tmpfs, so EROFS and ENOSPC here are real possibilities.
    try {
      await this.publish("ready");
    } catch (error) {
      this.warn("runtime_health_publish_failed", error);
    }
    // Re-checked after the await: a stop() landing during that publish finds
    // heartbeat still null and completes, and without this the interval below
    // would then be created with nothing left to clear it.
    if (this.stopped || shutdownSignal.aborted) return;
    this.heartbeat = setInterval(() => {
      // A tick can fire between clearInterval and the stopping publish; without
      // this the runtime could re-publish "ready" on its way out.
      if (this.stopped) return;
      // A failed heartbeat must not crash the runtime: staleness is what the
      // checker actually reasons about, and a file that stops advancing is
      // already the signal. Surface it and let the check fail.
      void this.publish("ready").catch((error: unknown) => {
        this.warn("runtime_health_heartbeat_failed", error);
      });
    }, this.options.heartbeatIntervalMs);
    // Never hold the process open on our own account.
    this.heartbeat.unref();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // Settle any publish still in flight before deciding. A stop() racing
    // start()'s first publish would otherwise see `published` still false,
    // return early, and let that publish land afterwards -- leaving a "ready"
    // file on disk for a worker that has already stopped.
    await this.publishing;
    // Never published, so there is nothing of ours on disk. Writing or
    // unlinking here would act on a file belonging to whoever did publish.
    if (!this.published) return;
    // Nor is the file still ours: on a shared path another runtime may have
    // claimed it since. Publishing "stopping" over it would be just as
    // destructive as the unlink -- it would mark a healthy runtime as draining
    // under our identity, and then delete it.
    if (!(await this.ownsPublishedFile())) return;
    // Mark not-ready first, then remove. A reader that catches the window sees
    // "stopping" rather than a stale "ready". Serialized behind any in-flight
    // heartbeat, so this is genuinely the last state written.
    try {
      await this.publish("stopping");
    } catch (error) {
      this.warn("runtime_health_teardown_failed", error);
    }
    // Its own try: an unlink skipped because the publish above failed would
    // leave the readiness file on disk for the whole drain.
    try {
      if (await this.ownsPublishedFile()) {
        await unlink(this.options.filePath);
      }
    } catch (error) {
      this.warn("runtime_health_teardown_failed", error);
    }
  }

  /**
   * Whether the file on disk is still the one this worker wrote.
   *
   * The `published` guard stops a worker that never wrote from deleting a
   * neighbour's file; this closes the other half of the same hazard on a
   * shared path -- A publishes, B clobbers the file, A drains and would
   * otherwise unlink B's readiness file, leaving a healthy B looking dead.
   */
  private async ownsPublishedFile(): Promise<boolean> {
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      const snapshot = JSON.parse(raw) as Partial<RuntimeHealthSnapshot>;
      return snapshot.runtimeId === this.options.runtimeId && snapshot.pid === this.options.pid;
    } catch {
      // Unreadable or malformed: not provably ours, so leave it alone. A file
      // we did write is removed on the next start anyway.
      return false;
    }
  }

  private warn(event: string, error: unknown): void {
    this.options.log?.warn?.(
      JSON.stringify({
        event,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
