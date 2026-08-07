import { randomBytes } from "node:crypto";
import { publishApprovedDraft } from "./publish.js";
import { withNotionAudit } from "./notion-audit.js";
import {
  handleSettingsCallback,
  handleSettingsInput,
  isSettingsInputReply,
  parseSettingsCallback,
  parseSettingsCommand,
  showSettings,
} from "./telegram-settings.js";
import { showUsageDashboard } from "./telegram-stats.js";

const CALLBACK_PATTERN = /^news:([pr]):([a-f0-9]{32,64})$/;
const ADMIN_STATUSES = new Set(["creator", "administrator"]);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_CONTROL_ERROR_CODES = new Set([
  "forbidden",
  "private_chat_required",
  "malformed_command",
  "missing_sender",
  "malformed_callback",
  "invalid_review_session",
  "publication_unresolved",
]);

export class ControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}

export function isTerminalControlError(error) {
  return (
    error instanceof ControlError &&
    TERMINAL_CONTROL_ERROR_CODES.has(error.code)
  );
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

export function parseStatsCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^\/stats(?:@([A-Za-z0-9_]+))?(\s.*)?$/i.exec(text.trim());
  if (!match) return null;
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

function addressedElsewhere(command, botUsername) {
  return Boolean(
    command.botUsername &&
      command.botUsername.toLowerCase() !== botUsername.toLowerCase(),
  );
}

export function classifyControlUpdate(update, botUsername, botId) {
  const settingsCommand = parseSettingsCommand(update?.message?.text);
  if (settingsCommand) {
    return addressedElsewhere(settingsCommand, botUsername)
      ? null
      : { kind: "settings_command", command: settingsCommand };
  }
  const statsCommand = parseStatsCommand(update?.message?.text);
  if (statsCommand) {
    return addressedElsewhere(statsCommand, botUsername)
      ? null
      : { kind: "stats_command", command: statsCommand };
  }
  const command = parseNewsCommand(update?.message?.text);
  if (command) {
    return addressedElsewhere(command, botUsername)
      ? null
      : { kind: "command", command };
  }

  const data = update?.callback_query?.data;
  if (typeof data === "string" && data.startsWith("cfg:")) {
    return {
      kind: "settings_callback",
      callback: parseSettingsCallback(data),
    };
  }
  if (typeof data === "string" && data.startsWith("news:")) {
    return {
      kind: "callback",
      callback: parseReviewCallback(data),
    };
  }
  if (isSettingsInputReply(update?.message, botId)) {
    return { kind: "settings_input" };
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
    name: {
      command: "Telegram admin - /news",
      callback: "Telegram admin - review callback",
      settings_command: "Telegram admin - /settings",
      settings_callback: "Telegram admin - settings callback",
      settings_input: "Telegram admin - settings input",
      stats_command: "Telegram admin - /stats",
    }[classification.kind],
    objective: `Process ${classification.kind} update ${update.update_id} from Telegram user ${actorId}.`,
  };
}

function updateKind(classification) {
  return {
    command: "news_command",
    callback: "news_callback",
    settings_command: "settings_command",
    settings_callback: "settings_callback",
    settings_input: "settings_input",
    stats_command: "stats_command",
  }[classification.kind];
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
    botId,
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
  const classification = classifyControlUpdate(update, botUsername, botId);
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
        let value;
        if (classification.kind === "command") {
          value = await handleNewsCommand(
            update.message,
            classification.command,
            {
              token,
              channelId,
              repository,
              callTelegram,
              runNews,
              now,
              newSessionId,
              updateId: update.update_id,
            },
          );
        } else if (classification.kind === "callback") {
          value = await handleReviewCallback(
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
        } else if (classification.kind === "settings_command") {
          value = await handleSettingsCommand(
            update.message,
            classification.command,
            { token, channelId, repository, callTelegram },
          );
        } else if (classification.kind === "settings_callback") {
          value = await handleSettingsControlCallback(
            update.callback_query,
            classification.callback,
            { token, channelId, repository, callTelegram, now },
          );
        } else if (classification.kind === "stats_command") {
          value = await handleStatsCommand(
            update.message,
            classification.command,
            { token, channelId, repository, callTelegram, now },
          );
        } else {
          value = await handleSettingsControlInput(update.message, {
            token,
            channelId,
            repository,
            callTelegram,
          });
        }
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
        const terminal = isTerminalControlError(error);
        await repository
          .finishTelegramUpdate(
            update.update_id,
            claimed.claim_token,
            terminal ? "completed" : "failed",
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

async function handleStatsCommand(
  message,
  command,
  { token, channelId, repository, callTelegram, now },
) {
  const chatId = requirePrivateChat(message);
  if (command.malformed) {
    throw new ControlError("malformed_command", "Malformed /stats command");
  }
  await requireAdmin(message, { token, channelId, callTelegram });
  await showUsageDashboard({
    token,
    channelId,
    chatId,
    repository,
    callTelegram,
    now,
  });
  return { auditResult: "Displayed the daily AI usage and cost dashboard." };
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

function requirePrivateChat(message) {
  const chatId = message?.chat?.id;
  if (message?.chat?.type !== "private" || chatId == null) {
    throw new ControlError("private_chat_required", "Private chat required");
  }
  return chatId;
}

async function handleSettingsCommand(
  message,
  command,
  { token, channelId, repository, callTelegram },
) {
  const chatId = requirePrivateChat(message);
  if (command.malformed) {
    throw new ControlError("malformed_command", "Malformed /settings command");
  }
  const userId = await requireAdmin(message, { token, channelId, callTelegram });
  await showSettings({
    token,
    channelId,
    chatId,
    userId,
    repository,
    callTelegram,
  });
  return { auditResult: "Opened the persisted Telegram news settings." };
}

async function handleSettingsControlCallback(
  callback,
  parsed,
  { token, channelId, repository, callTelegram, now },
) {
  requirePrivateChat(callback?.message);
  const userId = await requireAdmin(callback, {
    token,
    channelId,
    callTelegram,
  });
  return handleSettingsCallback(callback, parsed, {
    token,
    channelId,
    userId,
    repository,
    callTelegram,
    now,
  });
}

async function handleSettingsControlInput(
  message,
  { token, channelId, repository, callTelegram },
) {
  requirePrivateChat(message);
  const userId = await requireAdmin(message, {
    token,
    channelId,
    callTelegram,
  });
  return handleSettingsInput(message, {
    token,
    channelId,
    userId,
    repository,
    callTelegram,
  });
}

async function handleNewsCommand(
  message,
  command,
  {
    token,
    channelId,
    repository,
    callTelegram,
    runNews,
    now,
    newSessionId,
    updateId,
  },
) {
  const chatId = requirePrivateChat(message);
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
    text: "Research started. The result will appear here.",
  });
  let result;
  try {
    result = await runNews({ updateId, userId, chatId });
  } catch (error) {
    if (/unresolved/i.test(error?.message ?? "")) {
      throw new ControlError(
        "publication_unresolved",
        "Telegram publication outcome is unresolved and requires manual reconciliation",
      );
    }
    throw error;
  }
  if (result.status === "no_candidates") {
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: "No suitable recent news was found. Nothing was drafted or published.",
    });
    return {
      auditResult:
        "Research completed without a suitable candidate; no draft was created.",
    };
  }
  if (result.status === "published") {
    const messageId =
      result.publication?.telegram_message_id ??
      result.publication?.telegramMessageId ??
      result.publicationMessageId ??
      result.telegramMessageId;
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: messageId
        ? `Published automatically as Telegram message ${messageId}.`
        : "Published automatically.",
    });
    return {
      draftId: result.draftId ?? result.draft?.id,
      auditResult: `Automatically published draft ${result.draftId ?? result.draft?.id ?? "unknown"}.`,
    };
  }
  const delivered = await deliverReviewDraft({
    token,
    channelId,
    chatId,
    requestedBy: userId,
    repository,
    callTelegram,
    draftId: result.draftId,
    preview: result.preview,
    now,
    newSessionId,
  });
  if (delivered.unavailable) {
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: "This draft's review was already completed or is no longer actionable.",
    });
  }
  return {
    draftId: result.draftId,
    ...delivered,
    auditResult: delivered.unavailable
      ? `Draft ${result.draftId} already had a completed or unavailable review session.`
      : `Created review session for draft ${result.draftId}; explicit approval is required.`,
  };
}

export async function deliverReviewDraft({
  token,
  channelId,
  chatId,
  requestedBy,
  repository,
  callTelegram,
  draftId,
  preview,
  now = () => new Date(),
  newSessionId = () => randomBytes(24).toString("hex"),
}) {
  const expiresAt = new Date(now().valueOf() + SESSION_TTL_MS).toISOString();
  const existing = await repository.findTelegramReviewSessionByDraft?.(draftId);
  if (existing) {
    if (existing.decision != null) {
      return {
        draftId,
        previewMessageId: existing.preview_message_id,
        sessionId: existing.id,
        decision: existing.decision ?? null,
        resumed: true,
        unavailable: true,
      };
    }
    const markup = reviewMarkup(existing.id);
    let existingMessageAvailable = false;
    try {
      await callTelegram(token, "editMessageReplyMarkup", {
        chat_id: existing.control_chat_id,
        message_id: existing.preview_message_id,
        reply_markup: markup,
      });
      existingMessageAvailable = true;
    } catch (error) {
      existingMessageAvailable = /message is not modified/i.test(
        error?.message ?? "",
      );
    }
    if (existingMessageAvailable) {
      let reusable = existing;
      if (new Date(existing.expires_at).valueOf() <= now().valueOf()) {
        reusable = await repository.renewTelegramReviewSession?.({
          draftId,
          expiresAt,
        });
      }
      if (!reusable) {
        await callTelegram(token, "editMessageReplyMarkup", {
          chat_id: existing.control_chat_id,
          message_id: existing.preview_message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        return {
          draftId,
          previewMessageId: existing.preview_message_id,
          sessionId: existing.id,
          resumed: true,
          unavailable: true,
        };
      }
      return {
        draftId,
        previewMessageId: reusable.preview_message_id,
        sessionId: reusable.id,
        resumed: true,
      };
    }
    const replacement = await callTelegram(token, "sendMessage", {
      chat_id: existing.control_chat_id,
      text: preview,
      reply_markup: markup,
    });
    let reusable;
    try {
      reusable = await repository.rebindTelegramReviewSession?.({
        draftId,
        controlChatId: existing.control_chat_id,
        expectedPreviewMessageId: existing.preview_message_id,
        previewMessageId: replacement.message_id,
        expiresAt,
      });
    } catch (error) {
      const recovered =
        await repository.findTelegramReviewSessionByDraft?.(draftId);
      if (
        recovered?.decision == null &&
        Number(recovered?.preview_message_id) === Number(replacement.message_id)
      ) {
        reusable = recovered;
      } else {
        throw error;
      }
    }
    if (!reusable) {
      await callTelegram(token, "editMessageReplyMarkup", {
        chat_id: existing.control_chat_id,
        message_id: replacement.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
      return {
        draftId,
        previewMessageId: replacement.message_id,
        sessionId: existing.id,
        resumed: true,
        unavailable: true,
      };
    }
    return {
      draftId,
      previewMessageId: reusable.preview_message_id,
      sessionId: reusable.id,
      resumed: true,
      rebound: true,
    };
  }
  const sessionId = newSessionId();
  const previewMessage = await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: preview,
    reply_markup: reviewMarkup(sessionId),
  });
  await repository.createTelegramReviewSession({
    id: sessionId,
    draft_id: draftId,
    telegram_channel_id: channelId,
    control_chat_id: chatId,
    preview_message_id: previewMessage.message_id,
    requested_by: requestedBy,
    expires_at: expiresAt,
  });
  return {
    draftId,
    previewMessageId: previewMessage.message_id,
    sessionId,
  };
}

function reviewMarkup(sessionId) {
  return {
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
  let decision;
  try {
    decision = await repository.decideTelegramReviewSession({
      sessionId: parsed.sessionId,
      action: parsed.action,
      chatId,
      messageId,
      actorId: userId,
    });
  } catch (error) {
    if (/not found|expired|binding mismatch|not actionable/i.test(error.message)) {
      throw new ControlError(
        "invalid_review_session",
        "Review session is unavailable",
      );
    }
    throw error;
  }

  if (!decision.decision_won && decision.decision !== "publish") {
    await answerCallback(
      callTelegram,
      token,
      callback.id,
      decisionText(decision.decision),
      true,
    ).catch(() => {});
    return {
      auditResult: `Duplicate callback observed existing ${decision.decision} decision for draft ${decision.draft_id}.`,
    };
  }

  if (decision.decision_won) {
    await callTelegram(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  if (decision.decision === "reject") {
    await answerCallback(
      callTelegram,
      token,
      callback.id,
      "Draft rejected. Nothing was published.",
    ).catch(() => {});
    return {
      auditResult: `Rejected draft ${decision.draft_id}; no publication was attempted.`,
    };
  }

  await answerCallback(
    callTelegram,
    token,
    callback.id,
    decision.decision_won ? "Publishing..." : "Resuming publication...",
  ).catch(() => {});
  let published;
  try {
    published = await publishDraft({
      repository,
      token,
      channelId,
      draftId: decision.draft_id,
    });
  } catch (error) {
    if (/unresolved/i.test(error?.message ?? "")) {
      throw new ControlError(
        "publication_unresolved",
        "Telegram publication outcome is unresolved and requires manual reconciliation",
      );
    }
    throw error;
  }
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
