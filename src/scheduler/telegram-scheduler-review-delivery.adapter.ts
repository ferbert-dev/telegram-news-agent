import type {
  SchedulerReviewDeliveryApplicationPort,
  SchedulerReviewDeliveryInput,
  SchedulerReviewDeliveryResult,
} from "./scheduler-application.contracts.js";

/**
 * The narrow slice of DeliverTelegramReviewUseCase this adapter needs. Declared
 * structurally rather than importing the class so the scheduler side does not
 * depend on the Telegram application layer's concrete type.
 */
export type TelegramReviewDeliveryPort = {
  execute(input: {
    draftId: string;
    channelId: string;
    chatId: number;
    actorId: number;
    preview: string;
    signal?: AbortSignal;
  }): Promise<{ status: string; [key: string]: unknown }>;
};

/**
 * Translates between the scheduler's review-delivery port and
 * DeliverTelegramReviewUseCase, which already implements the behavior
 * (create/rebind/renew a review session, restore or disable controls, recover
 * an ambiguous rebind) but in a different input/output shape.
 *
 * Two real differences, not just renames:
 * - the scheduler calls the requesting admin `requestedBy`; the use case calls
 *   it `actorId`;
 * - the use case returns the open-ended `TelegramControlOutcome`
 *   (`{status: string, ...}`), while the scheduler port is a closed two-status
 *   union. Narrowing is therefore a real validation step, not a cast — see the
 *   unknown-status guard below.
 */
export class TelegramSchedulerReviewDeliveryAdapter
  implements SchedulerReviewDeliveryApplicationPort
{
  constructor(private readonly delivery: TelegramReviewDeliveryPort) {}

  async deliver(
    input: SchedulerReviewDeliveryInput,
  ): Promise<SchedulerReviewDeliveryResult> {
    const outcome = await this.delivery.execute({
      draftId: input.draftId,
      channelId: input.channelId,
      chatId: input.chatId,
      actorId: input.requestedBy,
      preview: input.preview,
      signal: input.signal,
    });

    if (outcome.status === "review_ready") {
      return { status: "review_ready", resumed: outcome.resumed === true };
    }
    if (outcome.status === "review_unavailable") {
      return {
        status: "review_unavailable",
        decision: normalizeDecision(outcome.decision),
        resumed: outcome.resumed === true,
      };
    }

    // Refuse to act on a status nobody checked: mapping an unrecognized one
    // onto "review_unavailable" would make the scheduler report
    // "review_already_resolved" for a review that may still be pending.
    //
    // Be aware of the exact consequence, which is stickier than a normal run
    // failure. RunScheduledNewsOnceUseCase wraps anything thrown by deliver()
    // as "Scheduled review delivery could not be completed", which its
    // errorCode() maps to `review_delivery_failed` — and that code is one of
    // the two explicitly excluded from calling finish(), so the schedule claim
    // is deliberately left held and retried once it goes stale. For a genuine
    // delivery failure that is the intended behavior. For a *shape* error like
    // this one it means the schedule stalls until the code is fixed, which is
    // the loud signal we want for what can only be a programming error
    // (DeliverTelegramReviewUseCase returns exactly two statuses today, so
    // reaching here requires someone adding a third without updating this
    // adapter) — but it is not a graceful degradation, and it is not what the
    // legacy scheduler did (src/news-scheduler.js treated any unrecognized
    // shape as awaiting_approval).
    throw new Error(
      `Telegram review delivery returned an unsupported status: ${String(outcome.status)}`,
    );
  }
}

function normalizeDecision(value: unknown): "publish" | "reject" | null {
  return value === "publish" || value === "reject" ? value : null;
}
