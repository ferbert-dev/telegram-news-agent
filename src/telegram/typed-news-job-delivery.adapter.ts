import type {
  TelegramCheckpointsPersistence,
  TelegramNewsJobClaimRow,
} from "./telegram-persistence.contracts.js";
import type { TelegramNewsJobDeliveryPort } from "./telegram-news-job-worker.js";

/**
 * The review hand-off, structurally typed so this adapter depends on neither
 * `DeliverTelegramReviewUseCase` nor the token that provides it. The outcome is
 * only inspected for `review_unavailable`, which is the typed runtime's name
 * for legacy's `{ unavailable: true }`.
 */
export type NewsJobReviewDeliveryPort = {
  execute(input: {
    draftId: string;
    channelId: string;
    chatId: number;
    actorId: number;
    preview: string;
    signal?: AbortSignal;
  }): Promise<{ status: string }>;
};

/** Satisfied by TelegramSchedulerNotificationAdapter without adaptation. */
export type NewsJobAdminMessagePort = {
  notify(input: { chatId: number; text: string; signal?: AbortSignal }): Promise<void>;
};

const REVIEW_UNAVAILABLE_TEXT =
  "This draft's review was already completed or is no longer actionable.";

/**
 * Renders a finished job's outcome for the operator.
 *
 * Every string is copied from `deliverTelegramNewsJobOutcome`
 * (src/telegram-news-jobs.js) rather than reworded. They are what the operator
 * has learned to read, and `checks/` and the legacy tests assert some of them
 * verbatim; a nicer phrasing here would be a silent behaviour change across a
 * cutover.
 *
 * Nothing is best effort. The scheduler treats its notifications as
 * fire-and-forget, but a `/news` outcome message *is* the job's delivery: if it
 * does not arrive, the operator who typed `/news` is left with no answer while
 * the channel's next `/news` stays suppressed behind a job that never
 * completed. So a failure here propagates, and the worker's delivery phase
 * retries it -- up to ten times, under `admin_delivery_failed`.
 */
export class TypedNewsJobDeliveryAdapter implements TelegramNewsJobDeliveryPort {
  constructor(
    private readonly options: {
      checkpoints: TelegramCheckpointsPersistence;
      reviewDelivery: NewsJobReviewDeliveryPort;
      adminMessages: NewsJobAdminMessagePort;
    },
  ) {}

  async deliver(
    job: TelegramNewsJobClaimRow,
    context: { signal?: AbortSignal },
  ): Promise<void> {
    const { signal } = context;
    signal?.throwIfAborted();

    if (job.outcome_status === "review_ready") {
      // The preview is read from the checkpoint rather than carried on the job
      // row, so the message the operator approves is the one the research
      // actually produced. The three-way check is legacy's, and each clause
      // matters: a mismatched draft id would present the wrong article for
      // approval, and an empty preview would send an empty review card with
      // live Publish and Reject buttons attached to it.
      const checkpoint = await this.options.checkpoints.getTelegramNewsCheckpoint(
        job.request_update_id,
      );
      if (
        checkpoint?.status !== "review_ready" ||
        // Required to be a real id, which legacy's `!==` comparison alone does
        // not establish: two nulls compare equal, so a review_ready checkpoint
        // with no draft would have passed there and been delivered as a review
        // card for nothing.
        typeof checkpoint.draft_id !== "string" ||
        !checkpoint.draft_id ||
        checkpoint.draft_id !== job.draft_id ||
        typeof checkpoint.preview !== "string" ||
        !checkpoint.preview
      ) {
        throw new Error("Durable Telegram news review checkpoint is invalid");
      }
      const delivered = await this.options.reviewDelivery.execute({
        draftId: checkpoint.draft_id,
        channelId: job.telegram_channel_id,
        chatId: job.control_chat_id,
        actorId: job.requested_by,
        preview: checkpoint.preview,
        ...(signal ? { signal } : {}),
      });
      if (delivered.status === "review_unavailable") {
        await this.options.adminMessages.notify({
          chatId: job.control_chat_id,
          text: REVIEW_UNAVAILABLE_TEXT,
          ...(signal ? { signal } : {}),
        });
      }
      return;
    }

    const text = this.outcomeText(job);
    if (text === null) {
      // Reached only by an outcome status with no rendering, which means the
      // job advanced into delivery in a state nothing can report. Failing is
      // right: silently completing would drop the operator's request.
      throw new Error("Durable Telegram news outcome is invalid");
    }
    await this.options.adminMessages.notify({
      chatId: job.control_chat_id,
      text,
      ...(signal ? { signal } : {}),
    });
  }

  private outcomeText(job: TelegramNewsJobClaimRow): string | null {
    switch (job.outcome_status) {
      case "no_candidates":
        return "No suitable recent news was found. Nothing was drafted or published.";
      case "published":
        return job.publication_message_id
          ? `Published automatically as Telegram message ${job.publication_message_id}.`
          : "Published automatically.";
      case "blocked_by_policy":
        return "Publication was blocked by the current excluded-topic policy. Nothing was sent to the news channel.";
      case "failed":
        return job.error_code === "publication_unresolved"
          ? "The news request stopped because publication status is unresolved. Reconcile the draft before starting /news again."
          : "The news request could not be completed after its retry budget. Check draft and publication status before starting /news again.";
      default:
        return null;
    }
  }
}
