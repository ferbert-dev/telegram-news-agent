import type { DraftRow } from "../../editorial/editorial-persistence.contracts.js";
import {
  PublicationMilestoneDeliveryError,
  type PublicationMilestoneDeliveryGateway,
} from "../../publication-milestones/publication-milestones.contracts.js";
import type {
  TelegramAdminAuthorizationGateway,
  TelegramControlOutcome,
  TelegramControlRequest,
  TelegramReviewPresentationGateway,
} from "../telegram-application.contracts.js";
import type { TelegramControlOutcomeRenderer } from "./telegram-control-transport.handler.js";

export type TelegramBotApiCall = (
  token: string,
  method: string,
  payload: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown>>;

const throwIfAborted = (signal?: AbortSignal): void => signal?.throwIfAborted();

const ADMIN_STATUSES = new Set(["creator", "administrator"]);

function reviewMarkup(sessionId: string): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Publish", callback_data: `news:p:${sessionId}` },
        { text: "Reject", callback_data: `news:r:${sessionId}` },
      ],
    ],
  };
}

function comparison(draft: DraftRow): {
  label: string;
  body: string;
  selectedLabel: string;
  qualitySummary: string | null;
} | null {
  let notes: unknown;
  try {
    notes = JSON.parse(draft.reviewer_notes ?? "{}");
  } catch {
    return null;
  }
  const editorial = (notes as { editorial_enrichment?: Record<string, unknown> })
    .editorial_enrichment;
  if (editorial?.status !== "completed") return null;
  const baseline = (editorial.baseline_draft as { telegramText?: unknown } | undefined)
    ?.telegramText;
  const enriched = (editorial.enriched_draft as { telegramText?: unknown } | undefined)
    ?.telegramText;
  const selectedVersion = editorial.selected_version;
  if (
    typeof baseline !== "string" ||
    typeof enriched !== "string" ||
    baseline === enriched ||
    draft.body !== (selectedVersion === "enriched" ? enriched : baseline)
  ) {
    return null;
  }
  const quality = editorial.quality as Record<string, unknown> | undefined;
  const readerAngle = quality?.reader_angle ?? quality?.readerAngle;
  const similarity = quality?.final_similarity ?? quality?.finalSimilarity;
  const retryAttempted = quality?.retry_attempted ?? quality?.retryAttempted;
  const retryStatus = quality?.retry_status ?? quality?.retryStatus;
  const wordCount = quality?.word_count ?? quality?.wordCount;
  const targetMin = quality?.target_min_words ?? quality?.targetMinWords;
  const targetMax = quality?.target_max_words ?? quality?.targetMaxWords;
  const qualitySummary = typeof readerAngle === "string" && readerAngle.trim()
    ? [
        `Reader angle: ${readerAngle.trim()}`,
        ...(typeof similarity === "number" && Number.isFinite(similarity)
          ? [`Lexical similarity to baseline: ${Math.round(similarity * 100)}%${retryAttempted ? `; rewrite ${String(retryStatus ?? "attempted")}` : ""}`]
          : []),
        ...(typeof wordCount === "number" && Number.isFinite(wordCount)
          ? [`Editorial length: ${wordCount} words (target ${String(targetMin)}–${String(targetMax)})`]
          : []),
      ].join("\n")
    : null;
  return selectedVersion === "enriched"
    ? {
        label: "Grounded baseline (for comparison)",
        body: baseline,
        selectedLabel: "Enriched version (selected for approval)",
        qualitySummary,
      }
    : {
        label: "Enriched candidate (collect-only comparison)",
        body: enriched,
        selectedLabel: "Grounded baseline (selected for approval)",
        qualitySummary,
      };
}

/** Concrete outbound adapter. It owns Telegram API shapes, not application policy. */
export class TelegramBotApiGateway
  implements
    TelegramAdminAuthorizationGateway,
    TelegramReviewPresentationGateway,
    PublicationMilestoneDeliveryGateway
{
  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly callTelegram: TelegramBotApiCall,
  ) {}

  async isChannelAdmin(channelId: string, actorId: number, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    const member = await this.callTelegram(this.token, "getChatMember", {
      chat_id: channelId || this.channelId,
      user_id: actorId,
    }, { signal });
    return ADMIN_STATUSES.has(String(member.status ?? ""));
  }

  async restoreControls(input: {
    chatId: number;
    messageId: number;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<"available" | "missing"> {
    try {
      throwIfAborted(input.signal);
      await this.callTelegram(this.token, "editMessageReplyMarkup", {
        chat_id: input.chatId,
        message_id: input.messageId,
        reply_markup: reviewMarkup(input.sessionId),
      }, { signal: input.signal });
      return "available";
    } catch (error) {
      if (input.signal?.aborted || error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      return /message is not modified/i.test(
        error instanceof Error ? error.message : "",
      )
        ? "available"
        : "missing";
    }
  }

  async disableControls(input: { chatId: number; messageId: number; signal?: AbortSignal }): Promise<void> {
    throwIfAborted(input.signal);
    await this.callTelegram(this.token, "editMessageReplyMarkup", {
      chat_id: input.chatId,
      message_id: input.messageId,
      reply_markup: { inline_keyboard: [] },
    }, { signal: input.signal });
  }

  async answerCallback(input: {
    callbackId: string;
    text: string;
    showAlert?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    throwIfAborted(input.signal);
    await this.callTelegram(this.token, "answerCallbackQuery", {
      callback_query_id: input.callbackId,
      text: input.text,
      show_alert: input.showAlert ?? false,
    }, { signal: input.signal });
  }

  async sendReview(input: {
    chatId: number;
    sessionId: string;
    preview: string;
    draft: DraftRow;
    signal?: AbortSignal;
  }): Promise<{ messageId: number }> {
    const alternate = comparison(input.draft);
    if (alternate) {
      const heading = `${alternate.label}${alternate.qualitySummary ? `\n${alternate.qualitySummary}` : ""}`;
      const footer = `Next: ${alternate.selectedLabel}, with Publish/Reject controls.`;
      const text = `${heading}\n\n${alternate.body}\n\n${footer}`;
      try {
        if (text.length <= 4096) {
          throwIfAborted(input.signal);
          await this.callTelegram(this.token, "sendMessage", {
            chat_id: input.chatId,
            text,
            disable_web_page_preview: true,
          }, { signal: input.signal });
        } else {
          throwIfAborted(input.signal);
          await this.callTelegram(this.token, "sendMessage", {
            chat_id: input.chatId,
            text: `${heading}. The following message is the alternative.\n\n${footer}`,
          }, { signal: input.signal });
          throwIfAborted(input.signal);
          await this.callTelegram(this.token, "sendMessage", {
            chat_id: input.chatId,
            text: alternate.body,
            disable_web_page_preview: true,
          }, { signal: input.signal });
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // Comparison is additive and cannot hide the selected review draft.
      }
    }
    throwIfAborted(input.signal);
    const sent = await this.callTelegram(this.token, "sendMessage", {
      chat_id: input.chatId,
      text: input.preview,
      reply_markup: reviewMarkup(input.sessionId),
    }, { signal: input.signal });
    const messageId = Number(sent.message_id);
    if (!Number.isSafeInteger(messageId)) {
      throw new Error("Telegram review response has no message id");
    }
    return { messageId };
  }

  async send(input: {
    channelId: string;
    text: string;
  }): Promise<{ messageId: number }> {
    try {
      const sent = await this.callTelegram(this.token, "sendMessage", {
        chat_id: input.channelId || this.channelId,
        text: input.text,
        disable_web_page_preview: true,
      });
      const messageId = Number(sent.message_id);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new Error("Telegram milestone response has no message id");
      }
      return { messageId };
    } catch (error) {
      throw new PublicationMilestoneDeliveryError(
        "Telegram milestone delivery outcome is uncertain",
        "uncertain",
        { cause: error },
      );
    }
  }
}

/** Required semantic outcomes are delivered before the update claim is completed. */
export class TelegramBotApiOutcomeRenderer implements TelegramControlOutcomeRenderer {
  constructor(
    private readonly token: string,
    private readonly callTelegram: TelegramBotApiCall,
  ) {}

  async render(
    request: TelegramControlRequest,
    outcome: TelegramControlOutcome,
    signal?: AbortSignal,
  ): Promise<void> {
    const text = this.message(request, outcome);
    if (!text) return;
    throwIfAborted(signal);
    const send = this.callTelegram(this.token, "sendMessage", {
      chat_id: request.chatId,
      text,
    }, { signal }).then(() => undefined);
    if (
      outcome.status === "blocked_by_policy" &&
      outcome.publicationPath === "manual_review"
    ) {
      await send.catch(() => undefined);
      return;
    }
    await send;
  }

  private message(
    request: TelegramControlRequest,
    outcome: TelegramControlOutcome,
  ): string | null {
    switch (outcome.status) {
      case "research_queued":
        return "Research queued. The result will appear here; /stats, /settings and /labs remain available while it runs.";
      case "already_running":
        return "A news search is already queued or running. The existing request will finish here.";
      case "research_started":
        return "Research started. The result will appear here.";
      case "no_candidates":
        return "No suitable recent news was found. Nothing was drafted or published.";
      case "blocked_by_policy":
        return "Publication was blocked by the current excluded-topic policy. Nothing was sent to the news channel.";
      case "review_unavailable":
        return "This draft's review was already completed or is no longer actionable.";
      case "published": {
        const publication = outcome.publication as
          | { telegram_message_id?: unknown }
          | undefined;
        const messageId = publication?.telegram_message_id ?? outcome.publicationMessageId;
        return request.route.kind === "review"
          ? `Published as Telegram message ${String(messageId)}.`
          : messageId
            ? `Published automatically as Telegram message ${String(messageId)}.`
            : "Published automatically.";
      }
      default:
        return null;
    }
  }
}
