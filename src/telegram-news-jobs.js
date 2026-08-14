import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STALE_AFTER_SECONDS = 30 * 60;
const DEFAULT_MAX_EXECUTION_ATTEMPTS = 3;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 10;

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

export function getTelegramNewsJobsConfig(env = process.env) {
  const mode = env.TELEGRAM_NEWS_JOB_MODE ?? "off";
  if (!new Set(["off", "enabled"]).has(mode)) {
    throw new Error("TELEGRAM_NEWS_JOB_MODE must be off or enabled");
  }
  if (mode === "off") {
    return {
      enabled: false,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      staleAfterSeconds: DEFAULT_STALE_AFTER_SECONDS,
      maxExecutionAttempts: DEFAULT_MAX_EXECUTION_ATTEMPTS,
      maxDeliveryAttempts: DEFAULT_MAX_DELIVERY_ATTEMPTS,
    };
  }
  return {
    enabled: true,
    pollIntervalMs: boundedInteger(
      env.TELEGRAM_NEWS_JOB_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      100,
      60_000,
      "TELEGRAM_NEWS_JOB_POLL_INTERVAL_MS",
    ),
    staleAfterSeconds: boundedInteger(
      env.TELEGRAM_NEWS_JOB_STALE_AFTER_SECONDS,
      DEFAULT_STALE_AFTER_SECONDS,
      30,
      3_600,
      "TELEGRAM_NEWS_JOB_STALE_AFTER_SECONDS",
    ),
    maxExecutionAttempts: boundedInteger(
      env.TELEGRAM_NEWS_JOB_MAX_EXECUTION_ATTEMPTS,
      DEFAULT_MAX_EXECUTION_ATTEMPTS,
      1,
      20,
      "TELEGRAM_NEWS_JOB_MAX_EXECUTION_ATTEMPTS",
    ),
    maxDeliveryAttempts: boundedInteger(
      env.TELEGRAM_NEWS_JOB_MAX_DELIVERY_ATTEMPTS,
      DEFAULT_MAX_DELIVERY_ATTEMPTS,
      1,
      50,
      "TELEGRAM_NEWS_JOB_MAX_DELIVERY_ATTEMPTS",
    ),
  };
}

function requireJob(job) {
  if (!job || typeof job !== "object") {
    throw new Error("Telegram news job claim is invalid");
  }
  if (job.claim_phase !== "execute" && job.claim_phase !== "deliver") {
    throw new Error("Telegram news job claim phase is invalid");
  }
  if (typeof job.id !== "string" || !job.id) {
    throw new Error("Telegram news job ID is invalid");
  }
  if (typeof job.claim_token !== "string" || !job.claim_token) {
    throw new Error("Telegram news job claim token is invalid");
  }
  return job;
}

function outcomeFromResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Telegram news job result is invalid");
  }
  if (
    !new Set([
      "review_ready",
      "published",
      "no_candidates",
      "blocked_by_policy",
    ]).has(result.status)
  ) {
    throw new Error("Telegram news job result status is invalid");
  }
  const draftId = result.draftId ?? result.draft?.id ?? null;
  if (
    new Set(["review_ready", "published", "blocked_by_policy"]).has(
      result.status,
    ) &&
    (typeof draftId !== "string" || !draftId)
  ) {
    throw new Error("Telegram news job result draft ID is invalid");
  }
  const publicationMessageId =
    result.publication?.telegram_message_id ??
    result.publicationMessageId ??
    null;
  if (
    result.status === "published" &&
    (!Number.isSafeInteger(Number(publicationMessageId)) ||
      Number(publicationMessageId) <= 0)
  ) {
    throw new Error("Telegram news job publication message ID is invalid");
  }
  return {
    outcomeStatus: result.status,
    draftId,
    publicationMessageId:
      publicationMessageId == null ? null : Number(publicationMessageId),
    errorCode: null,
  };
}

export async function deliverTelegramNewsJobOutcome({
  job,
  repository,
  signal,
  deliverReview,
  sendAdmin,
}) {
  signal?.throwIfAborted();
  if (job.outcome_status === "review_ready") {
    const checkpoint = await repository.getTelegramNewsCheckpoint(
      job.request_update_id,
    );
    if (
      checkpoint?.status !== "review_ready" ||
      checkpoint.draft_id !== job.draft_id ||
      typeof checkpoint.preview !== "string" ||
      !checkpoint.preview
    ) {
      throw new Error("Durable Telegram news review checkpoint is invalid");
    }
    const delivered = await deliverReview({
      channelId: job.telegram_channel_id,
      chatId: job.control_chat_id,
      requestedBy: job.requested_by,
      draftId: job.draft_id,
      preview: checkpoint.preview,
    });
    if (delivered?.unavailable) {
      await sendAdmin(
        job.control_chat_id,
        "This draft's review was already completed or is no longer actionable.",
      );
    }
    return;
  }

  const text =
    job.outcome_status === "no_candidates"
      ? "No suitable recent news was found. Nothing was drafted or published."
      : job.outcome_status === "published"
        ? job.publication_message_id
          ? `Published automatically as Telegram message ${job.publication_message_id}.`
          : "Published automatically."
        : job.outcome_status === "blocked_by_policy"
          ? "Publication was blocked by the current excluded-topic policy. Nothing was sent to the news channel."
          : job.outcome_status === "failed"
            ? job.error_code === "publication_unresolved"
              ? "The news request stopped because publication status is unresolved. Reconcile the draft before starting /news again."
              : "The news request could not be completed after its retry budget. Check draft and publication status before starting /news again."
            : null;
  if (text === null) {
    throw new Error("Durable Telegram news outcome is invalid");
  }
  await sendAdmin(job.control_chat_id, text);
}

export function startTelegramNewsJobClaimHeartbeat({
  repository,
  job,
  staleAfterSeconds,
  intervalMs = Math.max(1_000, Math.floor((staleAfterSeconds * 1_000) / 3)),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  let renewal = null;
  let lostError = null;
  let stopped = false;

  const renew = async () => {
    if (lostError) throw lostError;
    if (renewal) return renewal;
    renewal = (async () => {
      try {
        const renewed = await repository.renewTelegramNewsJobClaim({
          jobId: job.id,
          claimToken: job.claim_token,
        });
        if (!renewed) {
          lostError = new Error("Telegram news job claim ownership was lost");
          throw lostError;
        }
      } catch (error) {
        lostError ??= new Error(
          "Telegram news job claim could not be renewed",
          {
            cause: error,
          },
        );
        throw lostError;
      } finally {
        renewal = null;
      }
    })();
    return renewal;
  };

  const timer = setIntervalImpl(() => renew().catch(() => {}), intervalMs);
  timer?.unref?.();

  return {
    renew,
    assertOwned() {
      if (lostError) throw lostError;
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        clearIntervalImpl(timer);
      }
      await renewal;
      this.assertOwned();
    },
  };
}

function defaultExecutionError(error) {
  const message = error?.message ?? "";
  if (/unresolved|already being published/i.test(message)) {
    return { errorCode: "publication_unresolved", terminal: true };
  }
  if (/already running/i.test(message)) {
    return { errorCode: "pipeline_busy", terminal: false };
  }
  if (/rate.?limit/i.test(message)) {
    return { errorCode: "rate_limited", terminal: false };
  }
  return { errorCode: "news_job_failed", terminal: false };
}

async function stopHeartbeat(heartbeat, priorError) {
  try {
    await heartbeat.stop();
  } catch (error) {
    if (!priorError) throw error;
  }
}

export async function runTelegramNewsJobOnce({
  repository,
  runNewsJob,
  deliverOutcome,
  signal,
  claimToken = randomUUID(),
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
  maxExecutionAttempts = DEFAULT_MAX_EXECUTION_ATTEMPTS,
  maxDeliveryAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS,
  classifyExecutionError = defaultExecutionError,
  claimHeartbeatIntervalMs,
  setIntervalImpl,
  clearIntervalImpl,
}) {
  if (signal?.aborted) return { status: "stopped" };
  const claimed = await repository.claimNextTelegramNewsJob({
    claimToken,
    staleAfterSeconds,
    maxExecutionAttempts,
    maxDeliveryAttempts,
  });
  if (!claimed) return { status: "idle" };
  const job = requireJob(claimed);
  const heartbeat = startTelegramNewsJobClaimHeartbeat({
    repository,
    job,
    staleAfterSeconds,
    intervalMs: claimHeartbeatIntervalMs,
    setIntervalImpl,
    clearIntervalImpl,
  });

  if (job.claim_phase === "execute") {
    let outcomePersisted = false;
    try {
      const result = await runNewsJob(job, { signal });
      const outcome = outcomeFromResult(result);
      await heartbeat.renew();
      const saved = await repository.recordTelegramNewsJobOutcome({
        jobId: job.id,
        claimToken: job.claim_token,
        ...outcome,
      });
      if (!saved) {
        throw new Error("Telegram news job claim was lost before outcome");
      }
      outcomePersisted = true;
      await heartbeat.stop();
      if (signal?.aborted) return { status: "stopped", durable: true };
      return { status: "outcome_ready", job: saved };
    } catch (error) {
      if (outcomePersisted) {
        return { status: "outcome_ready", durable: true };
      }
      if (signal?.aborted) {
        await stopHeartbeat(heartbeat, error);
        return { status: "stopped", durable: false };
      }
      const failure = classifyExecutionError(error);
      let retryError;
      let saved;
      try {
        await heartbeat.renew();
        saved = await repository.retryTelegramNewsJob({
          jobId: job.id,
          claimToken: job.claim_token,
          errorCode: failure.errorCode,
          maxAttempts: maxExecutionAttempts,
          terminal: failure.terminal,
        });
      } catch (retryFailure) {
        retryError = retryFailure;
        throw retryFailure;
      } finally {
        await stopHeartbeat(heartbeat, retryError ?? error);
      }
      if (!saved)
        throw new Error("Telegram news job claim was lost before retry");
      return { status: saved.status, job: saved, errorCode: failure.errorCode };
    }
  }

  let deliveryCompleted = false;
  try {
    await deliverOutcome(job, { signal });
    await heartbeat.renew();
    const completed = await repository.completeTelegramNewsJob({
      jobId: job.id,
      claimToken: job.claim_token,
    });
    if (!completed) {
      throw new Error(
        "Telegram news job claim was lost before delivery completion",
      );
    }
    deliveryCompleted = true;
    await heartbeat.stop();
    return { status: "completed", job };
  } catch (error) {
    if (deliveryCompleted) {
      return { status: "completed", durable: true };
    }
    if (signal?.aborted) {
      await stopHeartbeat(heartbeat, error);
      return { status: "stopped", durable: true };
    }
    let retryError;
    let saved;
    try {
      await heartbeat.renew();
      saved = await repository.retryTelegramNewsJobDelivery({
        jobId: job.id,
        claimToken: job.claim_token,
        errorCode: "admin_delivery_failed",
        maxAttempts: maxDeliveryAttempts,
      });
    } catch (retryFailure) {
      retryError = retryFailure;
      throw retryFailure;
    } finally {
      await stopHeartbeat(heartbeat, retryError ?? error);
    }
    if (!saved) {
      throw new Error("Telegram news job claim was lost before delivery retry");
    }
    return {
      status: saved.status,
      job: saved,
      errorCode: "admin_delivery_failed",
    };
  }
}

export async function runTelegramNewsJobWorker({
  signal,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleepImpl = sleep,
  log = console,
  ...dependencies
}) {
  while (!signal.aborted) {
    let result;
    try {
      result = await runTelegramNewsJobOnce({
        ...dependencies,
        signal,
      });
      if (!new Set(["idle", "stopped"]).has(result.status)) {
        log.info?.(
          JSON.stringify({
            event: "telegram_news_job_progress",
            status: result.status,
            error_code: result.errorCode ?? null,
          }),
        );
      }
    } catch {
      if (signal.aborted) break;
      log.error?.(
        JSON.stringify({
          event: "telegram_news_job_worker_failed",
          error_code: "worker_iteration_failed",
        }),
      );
      result = { status: "failed" };
    }
    if (signal.aborted) break;
    if (result.status !== "idle" && result.status !== "failed") continue;
    try {
      await sleepImpl(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
