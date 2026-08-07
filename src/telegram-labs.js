const CALLBACK_PREFIX = "lab";
const CALLBACK_LIMIT_BYTES = 64;
const ARTICLE_TAGS = "article_tags";
const PAGES = new Set(["home", ARTICLE_TAGS]);
const STATES = new Set(["off", "collect", "enabled"]);

const STATE_CODES = Object.freeze({
  off: "o",
  collect: "c",
  enabled: "e",
});
const CODE_STATES = Object.freeze(
  Object.fromEntries(
    Object.entries(STATE_CODES).map(([state, code]) => [code, state]),
  ),
);
const STATE_LABELS = Object.freeze({
  off: "Off",
  collect: "Collect only",
  enabled: "Enabled",
});

function callbackData(parts) {
  const value = [CALLBACK_PREFIX, ...parts].join(":");
  if (Buffer.byteLength(value) > CALLBACK_LIMIT_BYTES) {
    throw new Error("Telegram Labs callback exceeds 64 bytes");
  }
  return value;
}

function parseVersion(value) {
  if (!/^\d{1,15}$/.test(value ?? "")) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

export function parseLabsCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^\/labs(?:@([A-Za-z0-9_]+))?(\s.*)?$/i.exec(text.trim());
  if (!match) return null;
  return {
    botUsername: match[1] ?? null,
    malformed: Boolean(match[2]?.trim()),
  };
}

export function createLabsCallback(action, value, version) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Invalid Labs callback version");
  }
  if (action === "view" && PAGES.has(value)) {
    return callbackData(["v", value === ARTICLE_TAGS ? "tags" : "home", version]);
  }
  if (action === "state" && STATES.has(value)) {
    return callbackData(["s", STATE_CODES[value], version]);
  }
  if (action === "close" && value === "done") {
    return callbackData(["x", "done", version]);
  }
  throw new Error("Invalid Labs callback action");
}

export function parseLabsCallback(data) {
  if (
    typeof data !== "string" ||
    !data.startsWith(`${CALLBACK_PREFIX}:`) ||
    Buffer.byteLength(data) > CALLBACK_LIMIT_BYTES
  ) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 4 || parts[0] !== CALLBACK_PREFIX) return null;
  const [, code, rawValue, rawVersion] = parts;
  const version = parseVersion(rawVersion);
  if (!version) return null;

  if (code === "v" && (rawValue === "home" || rawValue === "tags")) {
    return {
      action: "view",
      value: rawValue === "tags" ? ARTICLE_TAGS : "home",
      version,
    };
  }
  if (code === "s" && CODE_STATES[rawValue]) {
    return { action: "state", value: CODE_STATES[rawValue], version };
  }
  if (code === "x" && rawValue === "done") {
    return { action: "close", value: "done", version };
  }
  return null;
}

function articleTagsRow(rows) {
  if (!Array.isArray(rows)) return null;
  const row = rows.find((item) => item?.feature_key === ARTICLE_TAGS);
  if (
    !row ||
    !STATES.has(row.state) ||
    !Number.isSafeInteger(Number(row.version)) ||
    Number(row.version) < 1
  ) {
    return null;
  }
  return { ...row, version: Number(row.version) };
}

function stateLabel(state) {
  return STATE_LABELS[state] ?? state;
}

export function renderLabsText(rows, page = "home") {
  const feature = articleTagsRow(rows);
  if (!feature) throw new Error("Article tags feature flag is unavailable");
  const status = stateLabel(feature.state);
  if (page === ARTICLE_TAGS) {
    return [
      "Labs · Article tags",
      `Current status: ${status}`,
      "",
      "Off — keep the legacy pipeline without collecting tags.",
      "Collect only — store up to three tag assignments without changing the public draft.",
      "Enabled — also append localized hashtags to new drafts.",
      "",
      "Changes take effect immediately.",
    ].join("\n");
  }
  return [
    "Experimental Labs",
    "These features may change while we evaluate them. Changes take effect immediately.",
    "",
    `Article tags: ${status}`,
    "Story connections: Planned for V2 (not available yet).",
  ].join("\n");
}

export function renderClosedLabsText(rows) {
  const feature = articleTagsRow(rows);
  if (!feature) throw new Error("Article tags feature flag is unavailable");
  return [
    "✅ Labs changes are active",
    `Article tags: ${stateLabel(feature.state)}`,
    "",
    "The Labs menu is closed. Send /labs to open it again.",
  ].join("\n");
}

function button(text, action, value, version) {
  return {
    text,
    callback_data: createLabsCallback(action, value, version),
  };
}

export function renderLabsKeyboard(rows, page = "home") {
  const feature = articleTagsRow(rows);
  if (!feature) throw new Error("Article tags feature flag is unavailable");
  const { version } = feature;
  const close = [button("Done & close", "close", "done", version)];
  if (page === ARTICLE_TAGS) {
    return [
      ...["off", "collect", "enabled"].map((state) => [
        button(
          `${feature.state === state ? "✅ " : ""}${stateLabel(state)}`,
          "state",
          state,
          version,
        ),
      ]),
      [button("‹ Back", "view", "home", version)],
      close,
    ];
  }
  return [
    [
      button(
        `Article tags · ${stateLabel(feature.state)}`,
        "view",
        ARTICLE_TAGS,
        version,
      ),
    ],
    close,
  ];
}

function markup(rows, page) {
  return { inline_keyboard: renderLabsKeyboard(rows, page) };
}

async function editLabsMessage({
  token,
  callTelegram,
  chatId,
  messageId,
  rows,
  page,
  close = false,
}) {
  try {
    await callTelegram(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: close ? renderClosedLabsText(rows) : renderLabsText(rows, page),
      reply_markup: close ? { inline_keyboard: [] } : markup(rows, page),
    });
  } catch (error) {
    if (!/message is not modified/i.test(error?.message ?? "")) throw error;
  }
}

export async function showLabs({
  token,
  channelId,
  chatId,
  userId,
  repository,
  callTelegram,
}) {
  const existingSettings = await repository.getNewsSettings(channelId);
  if (!existingSettings) {
    await repository.getOrCreateNewsSettings({
      channelId,
      reviewChatId: chatId,
      updatedBy: userId,
    });
  }
  const rows = await repository.getOrCreateNewsFeatureFlags({
    channelId,
    updatedBy: userId,
  });
  if (!articleTagsRow(rows)) {
    throw new Error("Article tags feature flag was not initialized");
  }
  const sent = await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: renderLabsText(rows),
    reply_markup: markup(rows, "home"),
  });
  return { rows, messageId: sent.message_id };
}

export async function handleLabsCallback(
  callback,
  parsed,
  { token, channelId, userId, repository, callTelegram },
) {
  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  let answered = false;
  const answer = async (text, showAlert = false) => {
    if (answered) return;
    answered = true;
    try {
      await callTelegram(token, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text,
        show_alert: showAlert,
      });
    } catch {
      // Callback acknowledgements expire quickly and are non-durable. The
      // version-fenced database mutation and message redraw remain authoritative.
    }
  };
  const stale = async (auditResult) => {
    await answer("This Labs menu is out of date. Reopen /labs.", true);
    return { auditResult };
  };

  if (!parsed || chatId == null || messageId == null) {
    return stale("Rejected a malformed Labs callback.");
  }
  const rows = await repository.getNewsFeatureFlags(channelId);
  const current = articleTagsRow(rows);
  if (!current) {
    return stale("Labs callback had no article-tags feature row.");
  }
  if (parsed.version !== current.version) {
    return stale("Rejected a stale Labs callback version.");
  }

  if (parsed.action === "close") {
    await editLabsMessage({
      token,
      callTelegram,
      chatId,
      messageId,
      rows,
      page: "home",
      close: true,
    });
    await answer("Labs menu closed. Changes are active.");
    return { auditResult: "Closed Labs with immediate changes active." };
  }
  if (parsed.action === "view") {
    await editLabsMessage({
      token,
      callTelegram,
      chatId,
      messageId,
      rows,
      page: parsed.value,
    });
    await answer(parsed.value === "home" ? "Labs overview." : "Article tags opened.");
    return { auditResult: `Opened Labs page ${parsed.value}.` };
  }

  const updated = await repository.updateNewsFeatureFlag({
    channelId,
    featureKey: ARTICLE_TAGS,
    state: parsed.value,
    updatedBy: userId,
    expectedVersion: parsed.version,
  });
  if (!updated) {
    return stale("Labs feature update lost its version fence.");
  }
  const updatedRows = rows.map((row) =>
    row?.feature_key === ARTICLE_TAGS ? updated : row,
  );
  await editLabsMessage({
    token,
    callTelegram,
    chatId,
    messageId,
    rows: updatedRows,
    page: ARTICLE_TAGS,
  });
  await answer(`Article tags: ${stateLabel(updated.state)}. Active now.`);
  return {
    auditResult: `Changed article tags Labs state to ${updated.state}.`,
    feature: updated,
  };
}
