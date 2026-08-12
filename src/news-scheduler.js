import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeNewsSettings } from "./news-settings.js";
import { shouldDeferScheduledNews } from "./quiet-hours.js";
import { NoResearchCandidatesError } from "./research.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STALE_AFTER_SECONDS = 30 * 60;

function errorCode(error) {
  const messages = [error?.message ?? ""];
  if (error instanceof AggregateError) {
    messages.push(...error.errors.map((item) => item?.message ?? ""));
  }
  const message = messages.join(" ");
  if (error instanceof NoResearchCandidatesError) {
    return "no_candidates";
  }
  if (/already running/i.test(message)) {
    return "pipeline_busy";
  }
  if (/claim.*lost|ownership was lost/i.test(message)) {
    return "claim_lost";
  }
  if (/scheduled review delivery/i.test(message)) {
    return "review_delivery_failed";
  }
  if (/unresolved|already being published/i.test(message)) {
    return "publication_unresolved";
  }
  return "scheduled_run_failed";
}

export function startNewsScheduleClaimHeartbeat({
  repository,
  claim,
  staleAfterSeconds,
  intervalMs = Math.max(1_000, Math.floor((staleAfterSeconds * 1_000) / 3)),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  let lostError = null;
  let renewal = null;
  let stopped = false;

  const renew = async () => {
    if (lostError) throw lostError;
    if (renewal) return renewal;
    renewal = (async () => {
      try {
        const renewed = await repository.renewNewsScheduleClaim({
          channelId: claim.telegram_channel_id,
          claimToken: claim.schedule_claim_token,
        });
        if (!renewed) {
          lostError = new Error("Scheduled news claim ownership was lost");
          throw lostError;
        }
      } catch (error) {
        lostError ??= new Error("Scheduled news claim could not be renewed", {
          cause: error,
        });
        throw lostError;
      } finally {
        renewal = null;
      }
    })();
    return renewal;
  };

  const timer = setIntervalImpl(() => {
    renew().catch(() => {});
  }, intervalMs);
  timer?.unref?.();

  return {
    assertOwned() {
      if (lostError) throw lostError;
    },
    renew,
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

async function finish(
  repository,
  claim,
  status,
  failureCode = null,
  heartbeat,
) {
  await heartbeat?.stop();
  const finished = await repository.finishNewsSchedule({
    channelId: claim.telegram_channel_id,
    claimToken: claim.schedule_claim_token,
    status,
    errorCode: failureCode,
  });
  if (!finished) {
    throw new Error("Scheduled news claim was lost before completion");
  }
  return true;
}

async function requireSaved(operation) {
  if (!(await operation())) {
    throw new Error("Scheduled news claim was lost before checkpointing");
  }
}

function settingsForClaim(claim) {
  return normalizeNewsSettings(claim.schedule_settings_snapshot ?? claim);
}

function draftForClaim(claim) {
  if (!claim.schedule_draft_id) {
    return null;
  }
  return {
    id: claim.schedule_draft_id,
    preview: claim.schedule_preview,
    windowHours: Number(claim.schedule_window_hours),
  };
}

async function deferForQuietHours({
  repository,
  claim,
  settings,
  heartbeat,
  now,
}) {
  if (!shouldDeferScheduledNews(settings, now())) {
    return null;
  }
  await heartbeat.stop();
  const deferred = await repository.deferNewsScheduleForQuietHours({
    channelId: claim.telegram_channel_id,
    claimToken: claim.schedule_claim_token,
  });
  if (!deferred) {
    throw new Error("Scheduled news claim was lost before quiet-hours deferral");
  }
  return { status: "quiet_hours_deferred", settings };
}

function deferredDraftResult(deferral, scheduledDraft) {
  return {
    ...deferral,
    draftId: scheduledDraft.id,
    windowHours: scheduledDraft.windowHours,
  };
}

async function executeClaim({
  repository,
  claim,
  settings,
  runNews,
  publishDraft,
  deliverReviewDraft,
  notifyAdmin,
  log,
  heartbeat,
  now,
}) {
  const earlyDeferral = await deferForQuietHours({
    repository,
    claim,
    settings,
    heartbeat,
    now,
  });
  if (earlyDeferral) return earlyDeferral;

  let scheduledDraft = draftForClaim(claim);
  if (
    settings.approvalPolicy === "manual" &&
    (await repository.hasPendingTelegramReview(settings.channelId))
  ) {
    await finish(repository, claim, "skipped_pending_review", null, heartbeat);
    return { status: "skipped_pending_review", settings };
  }
  if (!scheduledDraft) {
    try {
      const { result, tier } = await runNews(settings);
      if (result.status !== "awaiting_approval") {
        throw new Error(
          `Scheduled pipeline must checkpoint a draft before ${result.status}`,
        );
      }
      scheduledDraft = {
        id: result.draft.id,
        preview: result.preview,
        windowHours: tier.windowHours,
      };
      await requireSaved(() =>
        repository.saveNewsScheduleDraft({
          channelId: claim.telegram_channel_id,
          claimToken: claim.schedule_claim_token,
          draftId: scheduledDraft.id,
          preview: scheduledDraft.preview,
          windowHours: scheduledDraft.windowHours,
        }),
      );
    } catch (error) {
      if (!(error instanceof NoResearchCandidatesError)) {
        throw error;
      }
      await finish(repository, claim, "no_candidates", null, heartbeat);
      return { status: "no_candidates", settings };
    }
  }

  const deliveryDeferral = await deferForQuietHours({
    repository,
    claim,
    settings,
    heartbeat,
    now,
  });
  if (deliveryDeferral) {
    return deferredDraftResult(deliveryDeferral, scheduledDraft);
  }

  if (settings.approvalPolicy === "manual") {
    await heartbeat.renew();
    const renewedDeferral = await deferForQuietHours({
      repository,
      claim,
      settings,
      heartbeat,
      now,
    });
    if (renewedDeferral) {
      return deferredDraftResult(renewedDeferral, scheduledDraft);
    }
    let delivery;
    try {
      delivery = await deliverReviewDraft({
        channelId: settings.channelId,
        chatId: settings.reviewChatId,
        requestedBy: settings.updatedBy,
        draftId: scheduledDraft.id,
        preview: scheduledDraft.preview,
      });
    } catch (error) {
      throw new Error("Scheduled review delivery could not be completed", {
        cause: error,
      });
    }
    const status = delivery?.unavailable
      ? "review_already_resolved"
      : "awaiting_approval";
    await finish(repository, claim, status, null, heartbeat);
    return {
      status,
      draftId: scheduledDraft.id,
      windowHours: scheduledDraft.windowHours,
      settings,
    };
  }

  let publicationMessageId = claim.schedule_publication_message_id;
  if (!publicationMessageId) {
    await heartbeat.renew();
    const renewedDeferral = await deferForQuietHours({
      repository,
      claim,
      settings,
      heartbeat,
      now,
    });
    if (renewedDeferral) {
      return deferredDraftResult(renewedDeferral, scheduledDraft);
    }
    const published = await publishDraft({ draftId: scheduledDraft.id });
    if (
      published.status === "blocked" ||
      published.status === "already_blocked"
    ) {
      await finish(
        repository,
        claim,
        "blocked_by_policy",
        published.reasonCode ?? "excluded_topic_policy",
        heartbeat,
      );
      return {
        status: "blocked_by_policy",
        draftId: scheduledDraft.id,
        publicationMessageId: null,
        windowHours: scheduledDraft.windowHours,
        settings,
      };
    }
    publicationMessageId = published.publication.telegram_message_id;
    await requireSaved(() =>
      repository.saveNewsSchedulePublication({
        channelId: claim.telegram_channel_id,
        claimToken: claim.schedule_claim_token,
        draftId: scheduledDraft.id,
        publicationMessageId,
      }),
    );
  }
  await finish(repository, claim, "published", null, heartbeat);
  await notifyAdmin(
    settings.reviewChatId,
    `Scheduled article published as Telegram message ${publicationMessageId}.`,
  ).catch(() => {
    log.error?.(
      JSON.stringify({
        event: "scheduled_news_receipt_failed",
        settings_version: settings.version,
      }),
    );
  });
  return {
    status: "published",
    draftId: scheduledDraft.id,
    publicationMessageId,
    windowHours: scheduledDraft.windowHours,
    settings,
  };
}

export async function runScheduledNewsOnce({
  repository,
  runNews,
  publishDraft,
  deliverReviewDraft,
  notifyAdmin = async () => {},
  claimToken = randomUUID(),
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
  log = console,
  withAudit = async (_context, operation) => operation(),
  claimHeartbeatIntervalMs,
  setIntervalImpl,
  clearIntervalImpl,
  now = () => new Date(),
}) {
  const claim = await repository.claimDueNewsSchedule({
    claimToken,
    staleAfterSeconds,
  });
  if (!claim) {
    return { status: "idle" };
  }

  const heartbeat = startNewsScheduleClaimHeartbeat({
    repository,
    claim,
    staleAfterSeconds,
    intervalMs: claimHeartbeatIntervalMs,
    setIntervalImpl,
    clearIntervalImpl,
  });
  let settings;
  try {
    settings = settingsForClaim(claim);
    return await withAudit({ claim, settings }, () =>
      executeClaim({
        repository,
        claim,
        settings,
        runNews,
        publishDraft,
        deliverReviewDraft,
        notifyAdmin,
        log,
        heartbeat,
        now,
      }),
    );
  } catch (error) {
    let code = errorCode(error);
    try {
      await heartbeat.stop();
    } catch {
      code = "claim_lost";
    }
    if (code === "publication_unresolved") {
      try {
        const paused = await repository.pauseNewsScheduleUnresolved({
          channelId: claim.telegram_channel_id,
          claimToken: claim.schedule_claim_token,
          errorCode: code,
        });
        if (!paused) {
          code = "claim_lost";
        } else {
          await notifyAdmin(
            settings?.reviewChatId ?? claim.review_chat_id,
            "Automatic publication has an unresolved Telegram outcome. The schedule was paused; reconcile the draft before enabling it again.",
          ).catch(() => {});
        }
      } catch {
        code = "schedule_pause_failed";
      }
    } else if (!new Set(["claim_lost", "review_delivery_failed"]).has(code)) {
      try {
        await finish(repository, claim, "failed", code);
      } catch {
        code = "claim_lost";
      }
    }
    log.error?.(
      JSON.stringify({
        event: "scheduled_news_failed",
        error_code: code,
        settings_version: settings?.version ?? null,
      }),
    );
    return { status: "failed", errorCode: code, settings };
  }
}

export async function runNewsScheduler({
  signal,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleepImpl = sleep,
  log = console,
  ...dependencies
}) {
  while (!signal.aborted) {
    try {
      const result = await runScheduledNewsOnce({ ...dependencies, log });
      if (result.status !== "idle") {
        log.info?.(
          JSON.stringify({
            event: "scheduled_news_completed",
            status: result.status,
            settings_version: result.settings?.version ?? null,
          }),
        );
      }
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      log.error?.(
        JSON.stringify({
          event: "news_scheduler_iteration_failed",
          error_code: "scheduler_unavailable",
        }),
      );
    }
    try {
      await sleepImpl(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
  }
}
