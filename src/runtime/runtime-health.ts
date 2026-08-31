import { chmod, rename, unlink, writeFile } from "node:fs/promises";

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
    const next = this.publishing.then(
      () => this.write(state),
      () => this.write(state),
    );
    this.publishing = next.catch(() => undefined);
    return next;
  }

  private async write(state: RuntimeHealthSnapshot["state"]): Promise<void> {
    const target = this.options.filePath;
    // Same directory, so the rename is atomic rather than a cross-device copy.
    // The sequence number keeps two publishes from ever sharing a temp path.
    const temporary = `${target}.${this.options.pid}.${(this.publishSequence += 1)}.tmp`;
    // Narrow at creation rather than after: a chmod that follows the write
    // leaves the snapshot briefly readable at the default umask, and it names
    // the lease owner.
    await writeFile(temporary, `${JSON.stringify(this.snapshot(state))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async start(shutdownSignal: AbortSignal): Promise<void> {
    if (this.stopped || shutdownSignal.aborted) return;
    await this.publish("ready");
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

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
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
      await unlink(this.options.filePath);
    } catch (error) {
      this.warn("runtime_health_teardown_failed", error);
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
