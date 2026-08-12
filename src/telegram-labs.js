const CALLBACK_PREFIX = "lab";
const CALLBACK_LIMIT_BYTES = 64;
const ARTICLE_TAGS = "article_tags";
const EDITORIAL_ENRICHMENT = "editorial_enrichment";
const PAGES = new Set(["home", ARTICLE_TAGS, EDITORIAL_ENRICHMENT]);
const STATES = new Set(["off", "collect", "enabled"]);

const FEATURE_CODES = Object.freeze({
  [ARTICLE_TAGS]: "tags",
  [EDITORIAL_ENRICHMENT]: "edit",
});
const CODE_FEATURES = Object.freeze(
  Object.fromEntries(
    Object.entries(FEATURE_CODES).map(([feature, code]) => [code, feature]),
  ),
);
const FEATURE_LABELS = Object.freeze({
  [ARTICLE_TAGS]: "Article tags",
  [EDITORIAL_ENRICHMENT]: "Editorial enrichment",
});

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

export function createLabsCallback(
  action,
  value,
  version,
  featureKey = ARTICLE_TAGS,
) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Invalid Labs callback version");
  }
  if (action === "view" && PAGES.has(value)) {
    return callbackData([
      "v",
      value === "home" ? "home" : FEATURE_CODES[value],
      version,
    ]);
  }
  if (
    action === "state" &&
    STATES.has(value) &&
    FEATURE_CODES[featureKey]
  ) {
    return featureKey === ARTICLE_TAGS
      ? callbackData(["s", STATE_CODES[value], version])
      : callbackData([
          "s",
          FEATURE_CODES[featureKey],
          STATE_CODES[value],
          version,
        ]);
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
  if (![4, 5].includes(parts.length) || parts[0] !== CALLBACK_PREFIX) {
    return null;
  }
  if (parts.length === 5) {
    const [, code, rawFeature, rawValue, rawVersion] = parts;
    const version = parseVersion(rawVersion);
    const featureKey = CODE_FEATURES[rawFeature];
    if (
      code === "s" &&
      featureKey &&
      CODE_STATES[rawValue] &&
      version
    ) {
      return {
        action: "state",
        value: CODE_STATES[rawValue],
        version,
        featureKey,
      };
    }
    return null;
  }
  const [, code, rawValue, rawVersion] = parts;
  const version = parseVersion(rawVersion);
  if (!version) return null;

  if (code === "v" && (rawValue === "home" || CODE_FEATURES[rawValue])) {
    return {
      action: "view",
      value: rawValue === "home" ? "home" : CODE_FEATURES[rawValue],
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

function featureRow(rows, featureKey) {
  if (!Array.isArray(rows)) return null;
  const row = rows.find((item) => item?.feature_key === featureKey);
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
  const feature = page === "home" ? null : featureRow(rows, page);
  if (page !== "home" && !feature) {
    throw new Error(`${FEATURE_LABELS[page] ?? "Labs"} feature flag is unavailable`);
  }
  if (page === EDITORIAL_ENRICHMENT) {
    const status = stateLabel(feature.state);
    return [
      "Labs · Editorial enrichment",
      `Current status: ${status}`,
      "",
      "Off — keep the grounded baseline and skip the editorial model call.",
      "Collect only — generate and store both versions, but keep the baseline as the review body.",
      "Enabled — generate both versions and use the enriched article as the review body.",
      "",
      "The editor enforces a grounded hook, causal arc, reader significance, and a 90–140 word target. It compares the result with the baseline and may make one additional grounded rewrite when they are too similar.",
      "The step uses full extracted evidence. It may make one narrow fact search only when necessary; searched facts must keep a source link and evidence mapping.",
      "Changes take effect immediately.",
    ].join("\n");
  }
  const articleTags = featureRow(rows, ARTICLE_TAGS);
  if (page === ARTICLE_TAGS && !articleTags) {
    throw new Error("Article tags feature flag is unavailable");
  }
  const editorial = featureRow(rows, EDITORIAL_ENRICHMENT);
  const selected = page === ARTICLE_TAGS ? articleTags : null;
  const status = selected ? stateLabel(selected.state) : null;
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
    `Article tags: ${stateLabel(articleTags?.state ?? "unavailable")}`,
    `Editorial enrichment: ${stateLabel(editorial?.state ?? "unavailable")}`,
    "Story connections: Planned for V2 (not available yet).",
  ].join("\n");
}

export function renderClosedLabsText(rows) {
  const articleTags = featureRow(rows, ARTICLE_TAGS);
  const editorial = featureRow(rows, EDITORIAL_ENRICHMENT);
  if (!articleTags || !editorial) {
    throw new Error("Labs feature flags are unavailable");
  }
  return [
    "✅ Labs changes are active",
    `Article tags: ${stateLabel(articleTags.state)}`,
    `Editorial enrichment: ${stateLabel(editorial.state)}`,
    "",
    "The Labs menu is closed. Send /labs to open it again.",
  ].join("\n");
}

function button(text, action, value, version, featureKey) {
  return {
    text,
    callback_data: createLabsCallback(action, value, version, featureKey),
  };
}

export function renderLabsKeyboard(rows, page = "home") {
  const feature =
    page === "home"
      ? featureRow(rows, ARTICLE_TAGS)
      : featureRow(rows, page);
  if (!feature) throw new Error("Labs feature flag is unavailable");
  const { version } = feature;
  const navigationVersion =
    featureRow(rows, ARTICLE_TAGS)?.version ?? version;
  const close = [
    button("Done & close", "close", "done", navigationVersion),
  ];
  if (page !== "home") {
    return [
      ...["off", "collect", "enabled"].map((state) => [
        button(
          `${feature.state === state ? "✅ " : ""}${stateLabel(state)}`,
          "state",
          state,
          version,
          page,
        ),
      ]),
      [button("‹ Back", "view", "home", navigationVersion)],
      close,
    ];
  }
  const featureButtons = [ARTICLE_TAGS, EDITORIAL_ENRICHMENT]
    .map((featureKey) => featureRow(rows, featureKey))
    .filter(Boolean)
    .map((row) => [
      button(
        `${FEATURE_LABELS[row.feature_key]} · ${stateLabel(row.state)}`,
        "view",
        row.feature_key,
        row.version,
      ),
    ]);
  return [
    ...featureButtons,
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
  if (
    !featureRow(rows, ARTICLE_TAGS) ||
    !featureRow(rows, EDITORIAL_ENRICHMENT)
  ) {
    throw new Error("Labs feature flags were not initialized");
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
  const featureKey =
    parsed?.action === "view" && parsed.value !== "home"
      ? parsed.value
      : parsed?.featureKey ?? ARTICLE_TAGS;
  const current = featureRow(rows, featureKey);
  if (!current) {
    return stale("Labs callback had no matching feature row.");
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
    await answer(
      parsed.value === "home"
        ? "Labs overview."
        : `${FEATURE_LABELS[parsed.value]} opened.`,
    );
    return { auditResult: `Opened Labs page ${parsed.value}.` };
  }

  const updated = await repository.updateNewsFeatureFlag({
    channelId,
    featureKey,
    state: parsed.value,
    updatedBy: userId,
    expectedVersion: parsed.version,
  });
  if (!updated) {
    return stale("Labs feature update lost its version fence.");
  }
  const updatedRows = rows.map((row) =>
    row?.feature_key === featureKey ? updated : row,
  );
  await editLabsMessage({
    token,
    callTelegram,
    chatId,
    messageId,
    rows: updatedRows,
    page: featureKey,
  });
  await answer(
    `${FEATURE_LABELS[featureKey]}: ${stateLabel(updated.state)}. Active now.`,
  );
  return {
    auditResult: `Changed ${featureKey} Labs state to ${updated.state}.`,
    feature: updated,
  };
}
