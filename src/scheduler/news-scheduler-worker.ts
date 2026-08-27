import { setTimeout as sleep } from "node:timers/promises";

import type { RuntimeWorker } from "../runtime/runtime-coordinator.js";
import type {
  RunScheduledNewsOnceInput,
  SchedulerApplicationPort,
  SchedulerRunResult,
} from "./scheduler-application.contracts.js";

/** Legacy `runNewsScheduler` cadence. Parity oracle: src/news-scheduler.js. */
export const NEWS_SCHEDULER_POLL_INTERVAL_MS = 30_000;
/** Ceiling for consecutive-failure backoff so a degraded database cannot spin. */
export const NEWS_SCHEDULER_MAX_BACKOFF_MS = 300_000;

export type NewsSchedulerLog = {
  info?(message: string): void;
  error?(message: string): void;
};

type SleepImpl = (
  delayMs: number,
  value?: unknown,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * Jitter applied above the normal cadence rather than clamped up from zero, so
 * every retry is strictly slower than the healthy poll interval and the
 * expected delay grows with consecutive failures.
 */
export function newsSchedulerBackoffDelay(
  consecutiveFailures: number,
  random: () => number = Math.random,
  pollIntervalMs: number = NEWS_SCHEDULER_POLL_INTERVAL_MS,
): number {
  const cadence =
    Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
      ? pollIntervalMs
      : NEWS_SCHEDULER_POLL_INTERVAL_MS;
  if (consecutiveFailures <= 0) {
    return cadence;
  }
  // Never below the configured cadence, so a caller-tuned interval is honoured
  // on the failure path exactly as it is on the healthy path.
  const ceiling = Math.max(
    cadence,
    Math.min(NEWS_SCHEDULER_MAX_BACKOFF_MS, cadence * 2 ** Math.min(consecutiveFailures, 6)),
  );
  const spread = ceiling - cadence;
  return cadence + Math.floor(Math.min(Math.max(random(), 0), 1) * spread);
}

/**
 * Stable, non-leaking code for an iteration failure. Mirrors the polling
 * worker's convention so operators can tell failure modes apart.
 */
export function schedulerIterationErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code)
    ? code
    : "scheduler_unavailable";
}

export type RunNewsSchedulerLoopOptions = {
  scheduler: SchedulerApplicationPort;
  signal: AbortSignal;
  pollIntervalMs?: number;
  sleepImpl?: SleepImpl;
  random?: () => number;
  log?: NewsSchedulerLog;
  /**
   * `claimToken` and `leaseOwnerId` are deliberately excluded: the use case
   * mints fresh identity per occurrence so each schedule claim and pipeline
   * lease stays single-writer. Pinning either would let a second occurrence or
   * process re-acquire a lease it does not own.
   */
  runInput?: Omit<
    RunScheduledNewsOnceInput,
    "signal" | "claimToken" | "leaseOwnerId"
  >;
  onReady?: () => void;
};

/**
 * The abortable occurrence loop. It owns nothing but iteration, sleep and
 * backoff: every claim, CAS token, checkpoint, quiet-hours deferral and
 * completion transition stays inside RunScheduledNewsOnceUseCase and its
 * PostgreSQL functions.
 */
export async function runNewsSchedulerLoop(
  options: RunNewsSchedulerLoopOptions,
): Promise<void> {
  const {
    scheduler,
    signal,
    pollIntervalMs = NEWS_SCHEDULER_POLL_INTERVAL_MS,
    sleepImpl = sleep,
    random = Math.random,
    log,
    runInput,
    onReady,
  } = options;

  onReady?.();

  let consecutiveFailures = 0;

  while (!signal.aborted) {
    let result: SchedulerRunResult | null = null;
    try {
      // DIVERGENCE FROM LEGACY: runNewsScheduler (src/news-scheduler.js) never
      // forwards its signal into an occurrence, so legacy occurrences always run
      // to completion and only the gap between them is cancellable. Forwarding it
      // makes shutdown promptly cancellable, at the cost that an abort landing
      // inside research discards that unfinished work and leaves the schedule
      // claim held until the stale threshold ages it out. A committed checkpoint
      // is never lost: no abort check sits between the workflow result and the
      // durable draft checkpoint.
      result = await scheduler.runOnce({ ...runInput, signal });
      consecutiveFailures = 0;
    } catch (error) {
      // An abort mid-occurrence is a normal drain. The use case has already
      // checkpointed any durable progress; do not report it as a failure.
      if (signal.aborted) {
        break;
      }
      consecutiveFailures += 1;
      log?.error?.(
        JSON.stringify({
          event: "news_scheduler_iteration_failed",
          error_code: schedulerIterationErrorCode(error),
          consecutive_failures: consecutiveFailures,
        }),
      );
    }

    if (result !== null && result.status !== "idle") {
      // The use case reports in-run failures as a resolved result rather than a
      // throw, so without this the only signal would be an info-level
      // "completed" line. Legacy runScheduledNewsOnce logged scheduled_news_failed
      // itself; the Nest use case has no logger, so the worker restores it.
      if (result.status === "failed") {
        log?.error?.(
          JSON.stringify({
            event: "scheduled_news_failed",
            error_code: result.errorCode ?? "scheduled_run_failed",
            settings_version: result.settings?.version ?? null,
          }),
        );
      }
      log?.info?.(
        JSON.stringify({
          event: "scheduled_news_completed",
          status: result.status,
          settings_version: result.settings?.version ?? null,
        }),
      );
    }

    if (signal.aborted) {
      break;
    }

    const delayMs =
      consecutiveFailures === 0
        ? pollIntervalMs
        : newsSchedulerBackoffDelay(consecutiveFailures, random, pollIntervalMs);
    try {
      await sleepImpl(delayMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      break;
    }
  }
}

export type NewsSchedulerWorkerOptions = {
  scheduler: SchedulerApplicationPort;
  pollIntervalMs?: number;
  sleepImpl?: SleepImpl;
  random?: () => number;
  log?: NewsSchedulerLog;
  runInput?: Omit<
    RunScheduledNewsOnceInput,
    "signal" | "claimToken" | "leaseOwnerId"
  >;
};

/**
 * RuntimeWorker adapter. Registered after the Telegram poller so the poller
 * owns readiness first; start() resolves as soon as the loop is running and
 * never blocks the coordinator's sequential worker start.
 */
export class NewsSchedulerWorker implements RuntimeWorker {
  readonly name = "news-scheduler";

  private readonly options: NewsSchedulerWorkerOptions;
  private currentStop: AbortController | null = null;
  /** Settles only after the run outcome has been classified, so stop() never
   *  races the fatal-reporting handler. It never rejects. */
  private currentRun: Promise<void> | null = null;
  private stopRequested = false;
  /** runNewsSchedulerLoop returns normally on abort, so any rejection it
   *  produces is a genuine failure rather than a drain artifact. */
  private failure: unknown = null;
  private failureReported = false;

  constructor(options: NewsSchedulerWorkerOptions) {
    this.options = options;
  }

  private startup: Promise<void> | null = null;

  async start(
    shutdownSignal: AbortSignal,
    reportFatal?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    if (this.currentRun !== null) {
      // Bind a concurrent caller to the in-flight readiness instead of
      // reporting success before the loop is running.
      await this.startup;
      return;
    }
    // Single-shot lifecycle, matching TelegramPollingWorker: stopRequested is
    // never cleared, so a stopped worker stays stopped and the coordinator builds
    // a new instance rather than restarting this one.
    if (this.stopRequested || shutdownSignal.aborted) {
      return;
    }

    const stopSignal = new AbortController();
    const abortFromHost = () => stopSignal.abort(shutdownSignal.reason);
    shutdownSignal.addEventListener("abort", abortFromHost, { once: true });

    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    this.startup = started;

    const run = runNewsSchedulerLoop({
      scheduler: this.options.scheduler,
      signal: stopSignal.signal,
      pollIntervalMs: this.options.pollIntervalMs,
      sleepImpl: this.options.sleepImpl,
      random: this.options.random,
      log: this.options.log ?? console,
      runInput: this.options.runInput,
      onReady: ready,
    });

    const settled: Promise<void> = run.then(
      () => {
        ready();
      },
      (error: unknown) => {
        ready();
        this.failure = error;
        if (reportFatal) {
          // The coordinator owns it from here; stop() must not surface the
          // same failure a second time.
          this.failureReported = true;
          void reportFatal(error);
        }
      },
    );
    this.currentRun = settled;
    this.currentStop = stopSignal;

    void settled.finally(() => {
      shutdownSignal.removeEventListener("abort", abortFromHost);
      if (this.currentRun === settled) {
        this.currentRun = null;
        this.currentStop = null;
        this.startup = null;
      }
    });

    await started;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.currentStop?.abort("runtime-stop");
    await this.currentRun;
    // Without a coordinator to report to, the failure would otherwise vanish.
    if (this.failure !== null && !this.failureReported) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
  }
}
