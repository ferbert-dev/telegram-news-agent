import type { RuntimeWorker } from "../runtime/runtime-coordinator.js";
import type {
  TelegramNewsJobClaimRow,
  TelegramNewsJobsPersistence,
} from "./telegram-persistence.contracts.js";

/** What a job's research phase produced. Mirrors the durable outcome columns. */
export type TelegramNewsJobOutcome = {
  status: "review_ready" | "published" | "no_candidates" | "blocked_by_policy";
  draftId?: string | null;
  publicationMessageId?: number | null;
};

export type TelegramNewsJobWorkflowPort = {
  run(
    job: TelegramNewsJobClaimRow,
    context: { signal?: AbortSignal },
  ): Promise<TelegramNewsJobOutcome>;
};

export type TelegramNewsJobDeliveryPort = {
  deliver(
    job: TelegramNewsJobClaimRow,
    context: { signal?: AbortSignal },
  ): Promise<void>;
};

export type TelegramNewsJobFailure = { errorCode: string; terminal: boolean };

export type TelegramNewsJobWorkerOptions = {
  jobs: TelegramNewsJobsPersistence;
  workflow: TelegramNewsJobWorkflowPort;
  delivery: TelegramNewsJobDeliveryPort;
  newClaimToken: () => string;
  pollIntervalMs?: number;
  staleAfterSeconds?: number;
  maxExecutionAttempts?: number;
  maxDeliveryAttempts?: number;
  claimHeartbeatIntervalMs?: number;
  classifyExecutionError?: (error: unknown) => TelegramNewsJobFailure;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
};

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STALE_AFTER_SECONDS = 1_800;
const DEFAULT_MAX_EXECUTION_ATTEMPTS = 3;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 10;

/** Legacy's default: anything unrecognised is retryable. */
function defaultExecutionError(error: unknown): TelegramNewsJobFailure {
  const code = (error as { code?: unknown })?.code;
  return {
    errorCode: typeof code === "string" && code ? code.slice(0, 128) : "news_job_failed",
    terminal: false,
  };
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Drains the durable `/news` queue.
 *
 * `/news` is an acceptance boundary: it records the request and returns, so a
 * long research run never blocks Telegram update processing. That only works if
 * something consumes the queue, and on the typed runtime nothing did -- the
 * command answered "Research queued" and the job sat there forever, which then
 * suppressed every later `/news` on that channel as "already running".
 *
 * The phases and their failure semantics mirror `src/telegram-news-jobs.js`
 * deliberately, because the durable guarantees live in the SQL functions and
 * both runtimes must drive them the same way. The two that matter most:
 *
 * - once an outcome is persisted, a later failure must NOT retry the research.
 *   The work is done and paid for; retrying would spend it again.
 * - a claim that has been lost (a `null`/`false` from the atomic functions)
 *   must abort the iteration rather than continue, because another worker now
 *   owns the job.
 */
export class TelegramNewsJobWorker implements RuntimeWorker {
  readonly name = "telegram-news-jobs";

  private readonly options: Required<
    Pick<
      TelegramNewsJobWorkerOptions,
      | "pollIntervalMs"
      | "staleAfterSeconds"
      | "maxExecutionAttempts"
      | "maxDeliveryAttempts"
      | "claimHeartbeatIntervalMs"
      | "classifyExecutionError"
      | "sleep"
      | "setIntervalImpl"
      | "clearIntervalImpl"
    >
  > &
    TelegramNewsJobWorkerOptions;

  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(options: TelegramNewsJobWorkerOptions) {
    const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
    this.options = {
      ...options,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      staleAfterSeconds,
      maxExecutionAttempts: options.maxExecutionAttempts ?? DEFAULT_MAX_EXECUTION_ATTEMPTS,
      maxDeliveryAttempts: options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS,
      // Renew well inside the stale window, so a slow research run cannot lose
      // its claim to the reaper while it is still working.
      claimHeartbeatIntervalMs:
        options.claimHeartbeatIntervalMs ?? Math.max(1_000, (staleAfterSeconds * 1000) / 3),
      classifyExecutionError: options.classifyExecutionError ?? defaultExecutionError,
      sleep: options.sleep ?? defaultSleep,
      setIntervalImpl:
        options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms)),
      clearIntervalImpl:
        options.clearIntervalImpl ??
        ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)),
    };
  }

  async start(shutdownSignal: AbortSignal): Promise<void> {
    if (this.stopped || shutdownSignal.aborted) return;
    this.running = this.loop(shutdownSignal);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // The coordinator aborts the shared signal before calling stop, so the loop
    // is already unwinding; this waits for the in-flight iteration to finish
    // rather than leaving it running past shutdown.
    await this.running?.catch(() => undefined);
    this.running = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopped) {
      let idle = true;
      try {
        idle = (await this.runOnce(signal)) === "idle";
      } catch (error) {
        this.options.log?.error?.(
          JSON.stringify({
            event: "telegram_news_job_worker_failed",
            error_code: "worker_iteration_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        idle = true;
      }
      if (signal.aborted || this.stopped) break;
      // Only pause when there was nothing to do. A queue with work in it is
      // drained back to back.
      if (idle) await this.options.sleep(this.options.pollIntervalMs, signal);
    }
  }

  /** One claim-and-advance. Returns "idle" when the queue had nothing. */
  async runOnce(signal?: AbortSignal): Promise<"idle" | "advanced" | "stopped"> {
    if (signal?.aborted) return "stopped";
    const claimToken = this.options.newClaimToken();
    const job = await this.options.jobs.claimNextTelegramNewsJob({
      claimToken,
      staleAfterSeconds: this.options.staleAfterSeconds,
      maxExecutionAttempts: this.options.maxExecutionAttempts,
      maxDeliveryAttempts: this.options.maxDeliveryAttempts,
    });
    if (!job) return "idle";

    const heartbeat = this.startHeartbeat(job);
    try {
      return job.claim_phase === "execute"
        ? await this.execute(job, heartbeat, signal)
        : await this.deliver(job, heartbeat, signal);
    } finally {
      // Idempotent, and never allowed to replace the real result: a teardown
      // failure must not become the iteration's error.
      try {
        heartbeat.stop();
      } catch {
        /* already reported through the phase's own handling */
      }
    }
  }

  private async execute(
    job: TelegramNewsJobClaimRow,
    heartbeat: { renew: () => Promise<void>; stop: () => void },
    signal?: AbortSignal,
  ): Promise<"advanced" | "stopped"> {
    let outcomePersisted = false;
    try {
      const outcome = await this.options.workflow.run(job, { ...(signal ? { signal } : {}) });
      await heartbeat.renew();
      const saved = await this.options.jobs.recordTelegramNewsJobOutcome({
        jobId: job.id,
        claimToken: job.claim_token,
        outcomeStatus: outcome.status,
        draftId: outcome.draftId ?? null,
        publicationMessageId: outcome.publicationMessageId ?? null,
      } as never);
      if (!saved) throw new Error("Telegram news job claim was lost before outcome");
      outcomePersisted = true;
      // Inside the try on purpose, matching legacy: stopping the heartbeat can
      // fail, and if it does the guard below is what stops a completed research
      // run being thrown away and paid for twice.
      heartbeat.stop();
      return signal?.aborted ? "stopped" : "advanced";
    } catch (error) {
      // The research already ran and its outcome is durable. Retrying would
      // spend the whole run again for nothing.
      if (outcomePersisted) return "advanced";
      if (signal?.aborted) return "stopped";
      const failure = this.options.classifyExecutionError(error);
      await heartbeat.renew();
      const saved = await this.options.jobs.retryTelegramNewsJob({
        jobId: job.id,
        claimToken: job.claim_token,
        errorCode: failure.errorCode,
        maxAttempts: this.options.maxExecutionAttempts,
        terminal: failure.terminal,
      } as never);
      if (!saved) throw new Error("Telegram news job claim was lost before retry");
      return "advanced";
    }
  }

  private async deliver(
    job: TelegramNewsJobClaimRow,
    heartbeat: { renew: () => Promise<void>; stop: () => void },
    signal?: AbortSignal,
  ): Promise<"advanced" | "stopped"> {
    let delivered = false;
    try {
      await this.options.delivery.deliver(job, { ...(signal ? { signal } : {}) });
      await heartbeat.renew();
      const completed = await this.options.jobs.completeTelegramNewsJob({
        jobId: job.id,
        claimToken: job.claim_token,
      });
      if (!completed) {
        throw new Error("Telegram news job claim was lost before delivery completion");
      }
      delivered = true;
      heartbeat.stop();
      return "advanced";
    } catch (error) {
      if (delivered) return "advanced";
      if (signal?.aborted) return "stopped";
      await heartbeat.renew();
      const saved = await this.options.jobs.retryTelegramNewsJobDelivery({
        jobId: job.id,
        claimToken: job.claim_token,
        errorCode: "admin_delivery_failed",
        maxAttempts: this.options.maxDeliveryAttempts,
      } as never);
      if (!saved) {
        throw new Error("Telegram news job claim was lost before delivery retry");
      }
      return "advanced";
    }
  }

  /**
   * Keeps the claim fresh while a phase runs. A failure to renew is not fatal
   * on its own: the atomic functions refuse a lost claim anyway, and that is
   * the check that actually protects the job.
   */
  private startHeartbeat(job: TelegramNewsJobClaimRow) {
    const renew = async () => {
      await this.options.jobs
        .renewTelegramNewsJobClaim({ jobId: job.id, claimToken: job.claim_token })
        .catch(() => undefined);
    };
    const handle = this.options.setIntervalImpl(() => {
      void renew();
    }, this.options.claimHeartbeatIntervalMs);
    let cleared = false;
    return {
      renew,
      stop: () => {
        if (cleared) return;
        // Marked before clearing, so a throwing teardown is not retried by the
        // finally and cannot be reported twice.
        cleared = true;
        this.options.clearIntervalImpl(handle);
      },
    };
  }
}
