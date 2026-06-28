import { randomBytes } from "node:crypto";
import { publishApprovedDraft } from "./publish.js";
import { withNotionAudit } from "./notion-audit.js";

const CALLBACK_PATTERN = /^news:([pr]):([a-f0-9]{32,64})$/;
const ADMIN_STATUSES = new Set(["creator", "administrator"]);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class ControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}

export function parseNewsCommand(text) {
  if (typeof text !== "string") {
    return null;
  }
  const match = /^\/news(?:@([A-Za-z0-9_]+))?(\s.*)?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  return {
    botUsername: match[1] ?? null,
    malformed: Boolean(match[2]?.trim()),
  };
}

export function createReviewCallback(action, sessionId) {
  const code = action === "publish" ? "p" : action === "reject" ? "r" : null;
  if (!code || !/^[a-f0-9]{32,64}$/.test(sessionId)) {
    throw new Error("Invalid review callback");
  }
  return `news:${code}:${sessionId}`;
}

export function parseReviewCallback(data) {
  const match = typeof data === "string" ? CALLBACK_PATTERN.exec(data) : null;
  if (!match) {
    return null;
  }
  return {
    action: match[1] === "p" ? "publish" : "reject",
    sessionId: match[2],
  };
}

export function classifyControlUpdate(update, botUsername) {
  const command = parseNewsCommand(update?.message?.text);
  if (command) {
    const addressedElsewhere =
      command.botUsername &&
      command.botUsername.toLowerCase() !== botUsername.toLowerCase();
    return addressedElsewhere ? null : { kind: "command", command };
  }

  const data = update?.callback_query?.data;
  if (typeof data === "string" && data.startsWith("news:")) {
    return {
      kind: "callback",
      callback: parseReviewCallback(data),
    };
  }
  return null;
}

export async function isChannelAdmin({
  token,
  channelId,
  userId,
  callTelegram,
}) {
  const member = await callTelegram(token, "getChatMember", {
    chat_id: channelId,
    user_id: userId,
  });
  return ADMIN_STATUSES.has(member?.status);
}

function auditDetails(classification, update) {
  const actorId =
    update.message?.from?.id ?? update.callback_query?.from?.id ?? "missing";
  return {
    name:
      classification.kind === "command"
        ? "Telegram admin - /news"
        : "Telegram admin - review callback",
    objective: `Process ${classification.kind} update ${update.update_id} from Telegram user ${actorId}.`,
  };
}

function updateKind(classification) {
  return classification.kind === "command" ? "news_command" : "news_callback";
}

function decisionText(decision) {
  return decision === "publish"
    ? "This draft was already approved."
    : "This draft was already rejected.";
}

export async function handleControlUpdate(
  update,
  {
    botUsername,
    token,
    channelId,
    repository,
    auditLogger,
    callTelegram,
    runNews,
    now = () => new Date(),
    newSessionId = () => randomBytes(24).toString("hex"),
    publishDraft = publishApprovedDraft,
  },
) {
  const classification = classifyControlUpdate(update, botUsername);
  if (!classification) {
    return { handled: false };
  }

  return withNotionAudit(
    auditLogger,
    auditDetails(classification, update),
    async (auditRun) => {
      const claimed = await repository.claimTelegramUpdate(
        update.update_id,
        updateKind(classification),
      );
      if (!claimed.claimed) {
        if (claimed.claim_status === "busy") {
          throw new ControlError(
            "update_in_progress",
            "Telegram update is still being processed",
          );
        }
        return {
          value: { handled: true, duplicate: true },
          auditResult: `Ignored duplicate Telegram update ${update.update_id}.`,
          auditLinks: auditRun.pageUrl,
        };
      }

      try {
        const value =
          classification.kind === "command"
            ? await handleNewsCommand(update.message, classification.command, {
                token,
                channelId,
                repository,
                callTelegram,
                runNews,
                now,
                newSessionId,
              })
            : await handleReviewCallback(
                update.callback_query,
                classification.callback,
                {
                  token,
                  channelId,
                  repository,
                  callTelegram,
                  publishDraft,
                },
              );
        const finished = await repository.finishTelegramUpdate(
          update.update_id,
          claimed.claim_token,
          "completed",
        );
        if (!finished) {
          throw new ControlError("update_claim_lost", "Update claim was lost");
        }
        return {
          value: { handled: true, ...value },
          auditResult: value.auditResult,
          auditLinks: auditRun.pageUrl,
        };
      } catch (error) {
        await repository
          .finishTelegramUpdate(
            update.update_id,
            claimed.claim_token,
            "failed",
            error instanceof ControlError ? error.code : "internal_error",
          )
          .catch(() => {});
        throw error;
      }
    },
    {
      outbox: repository,
      sanitizeError: (error) =>
        error instanceof ControlError ? error.code : "internal_error",
    },
  );
}

async function requireAdmin(message, dependencies) {
  const userId = message?.from?.id;
  if (!userId) {
    throw new ControlError("missing_sender", "Telegram sender is missing");
  }
  let authorized;
  try {
    authorized = await isChannelAdmin({ ...dependencies, userId });
  } catch (error) {
    throw new ControlError("authorization_unavailable", "Authorization failed", {
      cause: error,
    });
  }
  if (!authorized) {
    throw new ControlError("forbidden", "Administrator access required");
  }
  return userId;
}

async function handleNewsCommand(
  message,
  command,
  { token, channelId, repository, callTelegram, runNews, now, newSessionId },
) {
  const chatId = message?.chat?.id;
  if (message?.chat?.type !== "private" || chatId == null) {
    throw new ControlError("private_chat_required", "Private chat required");
  }
  if (command.malformed) {
    throw new ControlError("malformed_command", "Malformed /news command");
  }
  const userId = await requireAdmin(message, {
    token,
    channelId,
    callTelegram,
  });

  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: "Research started. A review draft will appear here.",
  });
  const result = await runNews();
  if (result.status === "no_candidates") {
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: "No verified primary-source AI news was found in the last 48 hours. Nothing was drafted.",
    });
    return {
      auditResult:
        "Research completed without a verified primary-source candidate; no draft was created.",
    };
  }
  const preview = await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: result.preview,
  });
  const sessionId = newSessionId();
  await repository.createTelegramReviewSession({
    id: sessionId,
    draft_id: result.draftId,
    control_chat_id: chatId,
    preview_message_id: preview.message_id,
    requested_by: userId,
    expires_at: new Date(now().valueOf() + SESSION_TTL_MS).toISOString(),
  });
  await callTelegram(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: preview.message_id,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Publish",
            callback_data: createReviewCallback("publish", sessionId),
          },
          {
            text: "Reject",
            callback_data: createReviewCallback("reject", sessionId),
          },
        ],
      ],
    },
  });
  return {
    draftId: result.draftId,
    auditResult: `Created review session for draft ${result.draftId}; explicit approval is required.`,
  };
}

async function handleReviewCallback(
  callback,
  parsed,
  { token, channelId, repository, callTelegram, publishDraft },
) {
  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  if (!parsed || chatId == null || messageId == null) {
    throw new ControlError("malformed_callback", "Invalid review callback");
  }
  if (callback.message.chat.type !== "private") {
    throw new ControlError("private_chat_required", "Private chat required");
  }
  const userId = await requireAdmin(callback, {
    token,
    channelId,
    callTelegram,
  });
  const decision = await repository.decideTelegramReviewSession({
    sessionId: parsed.sessionId,
    action: parsed.action,
    chatId,
    messageId,
    actorId: userId,
  });

  if (!decision.decision_won && decision.decision !== "publish") {
    await answerCallback(
      callTelegram,
      token,
      callback.id,
      decisionText(decision.decision),
      true,
    );
    return {
      auditResult: `Duplicate callback observed existing ${decision.decision} decision for draft ${decision.draft_id}.`,
    };
  }

  if (decision.decision_won) {
    await callTelegram(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  if (decision.decision === "reject") {
    await answerCallback(
      callTelegram,
      token,
      callback.id,
      "Draft rejected. Nothing was published.",
    );
    return {
      auditResult: `Rejected draft ${decision.draft_id}; no publication was attempted.`,
    };
  }

  await answerCallback(
    callTelegram,
    token,
    callback.id,
    decision.decision_won ? "Publishing..." : "Resuming publication...",
  );
  const published = await publishDraft({
    repository,
    token,
    channelId,
    draftId: decision.draft_id,
  });
  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: `Published as Telegram message ${published.publication.telegram_message_id}.`,
  });
  return {
    auditResult: `Published draft ${decision.draft_id} as Telegram message ${published.publication.telegram_message_id}.`,
  };
}

async function answerCallback(callTelegram, token, callbackId, text, showAlert = false) {
  await callTelegram(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: showAlert,
  });
}
