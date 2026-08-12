import {
  LANGUAGE_OPTIONS,
  TOPIC_PRESETS,
  validateCustomTopic,
} from "./news-settings.js";
import { EXCLUDED_TOPIC_TAXONOMY } from "./excluded-topics.js";
import { QUIET_HOURS_LABEL } from "./quiet-hours.js";

const CALLBACK_PREFIX = "cfg";
const CALLBACK_LIMIT_BYTES = 64;
const INPUT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SETTINGS_TIME_ZONE = "Europe/Madrid";
const PAGES = new Set([
  "home",
  "language",
  "topics",
  "custom",
  "approval",
  "automatic",
  "frequency",
  "quiet",
  "excluded",
]);
const INTERVALS = new Set([0, 60, 180, 360, 720, 1440]);

const languageEntries = Object.values(LANGUAGE_OPTIONS);
const topicEntries = Object.values(TOPIC_PRESETS);

function callbackData(parts) {
  const value = [CALLBACK_PREFIX, ...parts].join(":");
  if (Buffer.byteLength(value) > CALLBACK_LIMIT_BYTES) {
    throw new Error("Telegram settings callback exceeds 64 bytes");
  }
  return value;
}

function parseVersion(value) {
  if (!/^\d{1,15}$/.test(value ?? "")) {
    return null;
  }
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

export function parseSettingsCommand(text) {
  if (typeof text !== "string") {
    return null;
  }
  const match = /^\/settings(?:@([A-Za-z0-9_]+))?(\s.*)?$/i.exec(
    text.trim(),
  );
  if (!match) {
    return null;
  }
  return {
    botUsername: match[1] ?? null,
    malformed: Boolean(match[2]?.trim()),
  };
}

export function createSettingsCallback(action, value, version) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Invalid settings callback version");
  }
  switch (action) {
    case "view":
      if (!PAGES.has(value)) throw new Error("Invalid settings page");
      return callbackData(["v", value, version]);
    case "language":
      if (!LANGUAGE_OPTIONS[value]) throw new Error("Invalid language");
      return callbackData(["l", value, version]);
    case "topic_add":
    case "topic_remove":
      if (!TOPIC_PRESETS[value]) throw new Error("Invalid topic");
      return callbackData([action === "topic_add" ? "ta" : "tr", value, version]);
    case "topics_all":
      return callbackData(["tb", "all", version]);
    case "custom_prompt":
      return callbackData(["cp", "set", version]);
    case "custom_clear":
      return callbackData(["cc", "all", version]);
    case "approval":
      if (!new Set(["manual", "automatic"]).has(value)) {
        throw new Error("Invalid approval policy");
      }
      return callbackData(["a", value === "manual" ? "m" : "a", version]);
    case "interval": {
      const interval = Number(value);
      if (!INTERVALS.has(interval)) throw new Error("Invalid schedule interval");
      return callbackData(["i", interval, version]);
    }
    case "quiet":
      if (value !== "enabled" && value !== "disabled") {
        throw new Error("Invalid night pause state");
      }
      return callbackData(["q", value === "enabled" ? "e" : "d", version]);
    case "excluded_toggle":
      if (value !== "war_conflict") {
        throw new Error("Invalid excluded topic");
      }
      return callbackData(["x", "w", version]);
    case "status":
      if (value !== "applied") throw new Error("Invalid settings status");
      return callbackData(["s", "ok", version]);
    default:
      throw new Error("Invalid settings callback action");
  }
}

export function parseSettingsCallback(data) {
  if (typeof data !== "string" || !data.startsWith(`${CALLBACK_PREFIX}:`)) {
    return null;
  }
  if (Buffer.byteLength(data) > CALLBACK_LIMIT_BYTES) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 4 || parts[0] !== CALLBACK_PREFIX) {
    return null;
  }
  const [, code, rawValue, rawVersion] = parts;
  const version = parseVersion(rawVersion);
  if (!version) return null;

  if (code === "v" && PAGES.has(rawValue)) {
    return { action: "view", value: rawValue, version };
  }
  if (code === "l" && LANGUAGE_OPTIONS[rawValue]) {
    return { action: "language", value: rawValue, version };
  }
  if ((code === "ta" || code === "tr") && TOPIC_PRESETS[rawValue]) {
    return {
      action: code === "ta" ? "topic_add" : "topic_remove",
      value: rawValue,
      version,
    };
  }
  if (code === "tb" && rawValue === "all") {
    return { action: "topics_all", value: rawValue, version };
  }
  if (code === "cp" && rawValue === "set") {
    return { action: "custom_prompt", value: rawValue, version };
  }
  if (code === "cc" && rawValue === "all") {
    return { action: "custom_clear", value: rawValue, version };
  }
  if (code === "a" && (rawValue === "m" || rawValue === "a")) {
    return {
      action: "approval",
      value: rawValue === "m" ? "manual" : "automatic",
      version,
    };
  }
  if (code === "i" && INTERVALS.has(Number(rawValue))) {
    return { action: "interval", value: Number(rawValue), version };
  }
  if (code === "q" && (rawValue === "e" || rawValue === "d")) {
    return {
      action: "quiet",
      value: rawValue === "e" ? "enabled" : "disabled",
      version,
    };
  }
  if (code === "x" && rawValue === "w") {
    return {
      action: "excluded_toggle",
      value: "war_conflict",
      version,
    };
  }
  if (code === "s" && rawValue === "ok") {
    return { action: "status", value: "applied", version };
  }
  return null;
}

export function isSettingsInputReply(message, botId) {
  if (
    message?.chat?.type !== "private" ||
    typeof message.text !== "string" ||
    !message.reply_to_message?.message_id
  ) {
    return false;
  }
  const repliedTo = message.reply_to_message.from;
  return botId != null
    ? repliedTo?.id === botId
    : repliedTo?.is_bot === true;
}

function normalizeSettings(row) {
  return {
    channelId: row.telegram_channel_id ?? row.channelId ?? row.channel_id,
    reviewChatId: row.review_chat_id ?? row.reviewChatId ?? null,
    scheduleIntervalMinutes:
      row.schedule_interval_minutes ?? row.scheduleIntervalMinutes ?? null,
    languageCode: row.language_code ?? row.languageCode ?? "en",
    topicCodes: [...(row.topic_codes ?? row.topicCodes ?? [])],
    customTopics: [...(row.custom_topics ?? row.customTopics ?? [])],
    excludedTopicCodes: [
      ...(row.excluded_topic_codes ?? row.excludedTopicCodes ?? ["war_conflict"]),
    ],
    approvalPolicy: row.approval_policy ?? row.approvalPolicy ?? "manual",
    quietHoursEnabled:
      row.quiet_hours_enabled ?? row.quietHoursEnabled ?? true,
    nextRunAt: row.next_run_at ?? row.nextRunAt ?? null,
    lastRunStatus: row.last_run_status ?? row.lastRunStatus ?? null,
    scheduleDraftId: row.schedule_draft_id ?? row.scheduleDraftId ?? null,
    version: Number(row.version),
  };
}

function intervalLabel(minutes) {
  return minutes == null
    ? "Paused"
    : minutes === 1440
      ? "Every 24 hours"
      : `Every ${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
}

function languageLabel(code) {
  const option = LANGUAGE_OPTIONS[code];
  return option?.name ?? option?.label ?? code;
}

function topicLabel(code) {
  return TOPIC_PRESETS[code]?.label ?? code;
}

function excludedTopicLabel(code, languageCode) {
  return EXCLUDED_TOPIC_TAXONOMY[code]?.labels?.[languageCode] ?? code;
}

function formatNextRun(value, timeZone) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

export function renderSettingsText(
  row,
  { timeZone = DEFAULT_SETTINGS_TIME_ZONE } = {},
) {
  const settings = normalizeSettings(row);
  const topics = settings.topicCodes.map(topicLabel).join(", ") || "None";
  const custom = settings.customTopics.join(", ") || "None";
  const excluded =
    settings.excludedTopicCodes
      .map((code) => excludedTopicLabel(code, settings.languageCode))
      .join(", ") || "None";
  const nextRun = formatNextRun(settings.nextRunAt, timeZone);
  return [
    "News settings",
    "✅ Settings saved and active",
    "",
    `Language: ${languageLabel(settings.languageCode)}`,
    `Topics: ${topics}`,
    `Custom topics: ${custom}`,
    `Excluded-topic preference: ${excluded}`,
    `Publishing: ${settings.approvalPolicy === "automatic" ? "Auto-publish enabled ⚠️" : "Review required"}`,
    `Frequency: ${intervalLabel(settings.scheduleIntervalMinutes)}`,
    `Night pause: ${settings.quietHoursEnabled ? `Enabled (${QUIET_HOURS_LABEL})` : "Disabled"}`,
    `Next run (${timeZone}): ${nextRun}`,
    "",
    "Each change is applied immediately.",
  ].join("\n");
}

export function renderAppliedSettingsText(
  row,
  { timeZone = DEFAULT_SETTINGS_TIME_ZONE } = {},
) {
  const summary = renderSettingsText(row, { timeZone })
    .replace("News settings\n✅ Settings saved and active", "✅ Settings applied")
    .replace(
      "Each change is applied immediately.",
      "The settings menu is closed. Send /settings to change them again.",
    );
  return summary;
}

function button(text, action, value, version, style = null) {
  return {
    text,
    callback_data: createSettingsCallback(action, value, version),
    ...(style ? { style } : {}),
  };
}

function rowsOfTwo(buttons) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return rows;
}

export function renderSettingsKeyboard(row, page = "home") {
  const settings = normalizeSettings(row);
  const { version } = settings;
  if (page === "language") {
    return [
      ...rowsOfTwo(
        languageEntries.map((option) =>
          button(
            `${option.code === settings.languageCode ? "✅ " : ""}${option.name ?? option.label}`,
            "language",
            option.code,
            version,
          ),
        ),
      ),
      [button("‹ Back", "view", "home", version)],
    ];
  }
  if (page === "topics") {
    const selected = new Set(settings.topicCodes);
    return [
      ...rowsOfTwo(
        topicEntries.map((topic) =>
          button(
            `${selected.has(topic.code) ? "✅ " : ""}${topic.label}`,
            selected.has(topic.code) ? "topic_remove" : "topic_add",
            topic.code,
            version,
            selected.has(topic.code) ? "primary" : null,
          ),
        ),
      ),
      [
        button(
          "🌈 Broad mix",
          "topics_all",
          "all",
          version,
          selected.size === topicEntries.length ? "success" : null,
        ),
      ],
      [button("‹ Back", "view", "home", version)],
    ];
  }
  if (page === "custom") {
    return [
      [button("✍️ Add custom topic", "custom_prompt", "set", version)],
      ...(settings.customTopics.length
        ? [[button("Clear custom topics", "custom_clear", "all", version)]]
        : []),
      [button("‹ Back", "view", "home", version)],
    ];
  }
  if (page === "approval") {
    return [
      [
        button(
          `${settings.approvalPolicy === "manual" ? "✅ " : ""}Review required`,
          "approval",
          "manual",
          version,
        ),
      ],
      [
        button(
          settings.approvalPolicy === "automatic"
            ? "Auto-publish: Enabled ⚠️"
            : "Enable automatic publishing…",
          "view",
          "automatic",
          version,
        ),
      ],
      [button("‹ Back", "view", "home", version)],
    ];
  }
  if (page === "automatic") {
    if (settings.approvalPolicy === "automatic") {
      return [
        [button("Disable auto-publish", "approval", "manual", version)],
        [button("‹ Back", "view", "approval", version)],
      ];
    }
    return [
      [button("Enable auto-publish ⚠️", "approval", "automatic", version)],
      [button("Cancel", "view", "approval", version)],
    ];
  }
  if (page === "frequency") {
    const selectedInterval = settings.scheduleIntervalMinutes;
    return [
      [
        button(
          `${selectedInterval === 60 ? "✅ " : ""}Every hour`,
          "interval",
          60,
          version,
        ),
        button(
          `${selectedInterval === 180 ? "✅ " : ""}Every 3 hours`,
          "interval",
          180,
          version,
        ),
      ],
      [
        button(
          `${selectedInterval === 360 ? "✅ " : ""}Every 6 hours`,
          "interval",
          360,
          version,
        ),
        button(
          `${selectedInterval === 720 ? "✅ " : ""}Every 12 hours`,
          "interval",
          720,
          version,
        ),
      ],
      [
        button(
          `${selectedInterval === 1440 ? "✅ " : ""}Every 24 hours`,
          "interval",
          1440,
          version,
        ),
      ],
      [
        button(
          `${selectedInterval == null ? "✅ " : ""}Pause automatic search`,
          "interval",
          0,
          version,
        ),
      ],
      [button("‹ Back", "view", "home", version)],
    ];
  }
  if (page === "quiet") {
    return [
      [
        button(
          `${settings.quietHoursEnabled ? "✅ " : ""}Enabled · ${QUIET_HOURS_LABEL}`,
          "quiet",
          "enabled",
          version,
        ),
      ],
      [
        button(
          `${settings.quietHoursEnabled ? "" : "✅ "}Disabled`,
          "quiet",
          "disabled",
          version,
        ),
      ],
      [button("‹ Back", "view", "home", version)],
    ];
  }
  if (page === "excluded") {
    const selected = new Set(settings.excludedTopicCodes);
    return [
      [
        button(
          `${selected.has("war_conflict") ? "✅ " : ""}${excludedTopicLabel("war_conflict", settings.languageCode)}`,
          "excluded_toggle",
          "war_conflict",
          version,
          selected.has("war_conflict") ? "primary" : null,
        ),
      ],
      [button("‹ Back", "view", "home", version)],
    ];
  }
  return [
    [button("1 · Language", "view", "language", version)],
    [button("2 · Topics", "view", "topics", version)],
    [button("3 · Custom topics", "view", "custom", version)],
    [button("4 · Publishing", "view", "approval", version)],
    [button("5 · Frequency", "view", "frequency", version)],
    [
      button(
        `6 · Night pause · ${settings.quietHoursEnabled ? "Enabled" : "Disabled"}`,
        "view",
        "quiet",
        version,
      ),
    ],
    [
      button(
        `7 · Excluded topics · ${settings.excludedTopicCodes.length}`,
        "view",
        "excluded",
        version,
      ),
    ],
    [
      button(
        "✅ Apply & close settings",
        "status",
        "applied",
        version,
        "success",
      ),
    ],
  ];
}

function telegramMarkup(settings, page) {
  return { inline_keyboard: renderSettingsKeyboard(settings, page) };
}

async function editSettingsMessage({
  token,
  callTelegram,
  chatId,
  messageId,
  settings,
  page = "home",
  close = false,
}) {
  const pageNotice =
    page === "automatic"
      ? normalizeSettings(settings).approvalPolicy === "automatic"
        ? "\n\nAuto-publish is enabled ⚠️ New articles are sent without review."
        : "\n\nWarning: automatic publishing sends new articles to the channel without review."
      : page === "frequency"
        ? "\n\nCost note: every-hour search can consume provider and web-search credits quickly."
        : page === "quiet"
          ? `\n\nWhen enabled, scheduled work waits until 08:00 and never publishes between 22:00 and 08:00 (${QUIET_HOURS_LABEL.split(" ").at(-1)}). Explicit manual Publish remains available.`
          : page === "excluded"
            ? "\n\nThis is an excluded-topic preference. It does not replace manual review or guarantee that every related article is removed."
        : "";
  try {
    await callTelegram(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: close
        ? renderAppliedSettingsText(settings)
        : `${renderSettingsText(settings)}${pageNotice}`,
      reply_markup: close
        ? { inline_keyboard: [] }
        : telegramMarkup(settings, page),
    });
    return true;
  } catch (error) {
    if (/message is not modified/i.test(error?.message ?? "")) {
      return false;
    }
    throw error;
  }
}

function updatePayload(settings, changes, { channelId, chatId, userId, version }) {
  return {
    channelId,
    reviewChatId: chatId,
    scheduleIntervalMinutes: settings.scheduleIntervalMinutes,
    languageCode: settings.languageCode,
    topicCodes: settings.topicCodes,
    customTopics: settings.customTopics,
    approvalPolicy: settings.approvalPolicy,
    quietHoursEnabled: settings.quietHoursEnabled,
    updatedBy: userId,
    expectedVersion: version,
    ...changes,
  };
}

export async function showSettings({
  token,
  channelId,
  chatId,
  userId,
  repository,
  callTelegram,
}) {
  const settings = await repository.getOrCreateNewsSettings({
    channelId,
    reviewChatId: chatId,
    updatedBy: userId,
  });
  const sent = await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: renderSettingsText(settings),
    reply_markup: telegramMarkup(settings, "home"),
  });
  return { settings, messageId: sent.message_id };
}

export async function handleSettingsCallback(
  callback,
  parsed,
  { token, channelId, userId, repository, callTelegram, now = () => new Date() },
) {
  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  let answered = false;
  const answer = async (text, showAlert = false) => {
    if (answered) return;
    answered = true;
    await callTelegram(token, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text,
      show_alert: showAlert,
    });
  };

  try {
    if (!parsed) {
      await answer("Invalid settings action.", true);
      return { auditResult: "Rejected a malformed settings callback." };
    }
    const currentRow = await repository.getNewsSettings(channelId);
    if (!currentRow) {
      await answer("Open /settings again.", true);
      return { auditResult: "Settings callback had no configuration row." };
    }
    const current = normalizeSettings(currentRow);

    if (parsed.action === "status") {
      await editSettingsMessage({
        token,
        callTelegram,
        chatId,
        messageId,
        settings: currentRow,
        close: true,
      });
      await answer("Settings applied. Menu closed.");
      return { auditResult: "Confirmed settings and closed the settings menu." };
    }

    if (parsed.action === "view") {
      await editSettingsMessage({
        token,
        callTelegram,
        chatId,
        messageId,
        settings: currentRow,
        page: parsed.value,
      });
      await answer(
        parsed.value === "home"
          ? "Settings are saved and active."
          : "Settings opened.",
      );
      return { auditResult: `Opened settings page ${parsed.value}.` };
    }

    if (parsed.action === "custom_prompt") {
      if (current.topicCodes.length + current.customTopics.length >= 12) {
        await answer("Remove a topic before adding another one.", true);
        return { auditResult: "Custom topic rejected because the topic limit was reached." };
      }
      if (current.customTopics.length >= 5) {
        await answer("You can add up to five custom topics.", true);
        return { auditResult: "Custom topic rejected because the custom-topic limit was reached." };
      }
      const prompt = await callTelegram(token, "sendMessage", {
        chat_id: chatId,
        text: "Reply with one custom news topic (2-80 characters).",
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "For example: marine biology",
        },
      });
      await repository.beginTelegramSettingsInput({
        controlChatId: chatId,
        requestedBy: userId,
        promptMessageId: prompt.message_id,
        expiresAt: new Date(now().valueOf() + INPUT_TTL_MS).toISOString(),
      });
      await answer("Send the topic as a reply.");
      return { auditResult: "Started a bound custom-topic input." };
    }

    if (parsed.action === "excluded_toggle") {
      const excludedTopicCodes = current.excludedTopicCodes.includes(parsed.value)
        ? current.excludedTopicCodes.filter((code) => code !== parsed.value)
        : [...current.excludedTopicCodes, parsed.value];
      const updated = await repository.updateNewsExcludedTopics({
        channelId,
        excludedTopicCodes,
        updatedBy: userId,
        expectedVersion: parsed.version,
      });
      if (!updated) {
        const latest = await repository.getNewsSettings(channelId);
        await editSettingsMessage({
          token,
          callTelegram,
          chatId,
          messageId,
          settings: latest,
          page: "excluded",
        });
        await answer("Settings changed elsewhere; refreshed.", true);
        return {
          auditResult:
            "Rejected a stale excluded topic mutation and refreshed the UI.",
        };
      }
      await editSettingsMessage({
        token,
        callTelegram,
        chatId,
        messageId,
        settings: updated,
        page: "excluded",
      });
      await answer("Saved and applied.");
      return { auditResult: "Updated excluded topic settings." };
    }

    let changes;
    let returnPage = "home";
    if (parsed.action === "language") {
      changes = { languageCode: parsed.value };
      returnPage = "language";
    } else if (parsed.action === "topic_add") {
      if (
        !current.topicCodes.includes(parsed.value) &&
        current.topicCodes.length + current.customTopics.length >= 12
      ) {
        await answer("Remove a topic before adding another one.", true);
        return { auditResult: "Preset topic rejected because the topic limit was reached." };
      }
      changes = { topicCodes: [...new Set([...current.topicCodes, parsed.value])] };
      returnPage = "topics";
    } else if (parsed.action === "topic_remove") {
      const topicCodes = current.topicCodes.filter((code) => code !== parsed.value);
      if (!topicCodes.length && !current.customTopics.length) {
        await answer("Keep at least one topic.", true);
        return { auditResult: "Rejected removal of the final topic." };
      }
      changes = { topicCodes };
      returnPage = "topics";
    } else if (parsed.action === "topics_all") {
      if (topicEntries.length + current.customTopics.length > 12) {
        await answer("Clear some custom topics before selecting the broad mix.", true);
        return { auditResult: "Broad mix rejected because the total topic limit was reached." };
      }
      changes = { topicCodes: topicEntries.map((topic) => topic.code) };
      returnPage = "topics";
    } else if (parsed.action === "custom_clear") {
      if (!current.topicCodes.length) {
        await answer("Keep at least one topic.", true);
        return { auditResult: "Rejected clearing the final custom topic." };
      }
      changes = { customTopics: [] };
      returnPage = "custom";
    } else if (parsed.action === "approval") {
      changes = { approvalPolicy: parsed.value };
      returnPage = "approval";
    } else if (parsed.action === "interval") {
      if (
        parsed.value !== 0 &&
        current.lastRunStatus === "publication_unresolved" &&
        current.scheduleDraftId
      ) {
        const draft = await repository.getDraft(current.scheduleDraftId);
        if (!new Set(["approved", "published"]).has(draft.status)) {
          await answer(
            "Reconcile the uncertain publication before enabling the schedule.",
            true,
          );
          return {
            auditResult:
              "Rejected schedule enable while a publication remained unresolved.",
          };
        }
      }
      changes = { scheduleIntervalMinutes: parsed.value === 0 ? null : parsed.value };
      returnPage = "frequency";
    } else if (parsed.action === "quiet") {
      changes = { quietHoursEnabled: parsed.value === "enabled" };
      returnPage = "quiet";
    }

    const updated = await repository.updateNewsSettings(
      updatePayload(current, changes, {
        channelId,
        chatId,
        userId,
        version: parsed.version,
      }),
    );
    if (!updated) {
      const latest = await repository.getNewsSettings(channelId);
      await editSettingsMessage({
        token,
        callTelegram,
        chatId,
        messageId,
        settings: latest,
        page: returnPage,
      });
      await answer("Settings changed elsewhere; refreshed.", true);
      return { auditResult: "Rejected a stale settings mutation and refreshed the UI." };
    }
    await editSettingsMessage({
      token,
      callTelegram,
      chatId,
      messageId,
      settings: updated,
      page: returnPage,
    });
    await answer("Saved and applied.");
    return { auditResult: `Updated news settings (${parsed.action}).` };
  } catch (error) {
    await answer("The settings change could not be completed.", true).catch(() => {});
    throw error;
  }
}

export async function handleSettingsInput(
  message,
  { token, channelId, userId, repository, callTelegram },
) {
  const chatId = message.chat.id;
  const promptMessageId = message.reply_to_message.message_id;
  let topic;
  try {
    topic = validateCustomTopic(message.text);
  } catch (error) {
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: `${error.message}. Reply to the same prompt and try again.`,
    });
    return { auditResult: "Rejected invalid custom-topic input." };
  }

  const binding = await repository.consumeTelegramSettingsInput({
    controlChatId: chatId,
    requestedBy: userId,
    promptMessageId,
  });
  if (!binding) {
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: "This topic request expired. Open /settings and try again.",
    });
    return { auditResult: "Ignored expired or mismatched custom-topic input." };
  }

  let updated = null;
  for (let attempt = 0; attempt < 2 && !updated; attempt += 1) {
    const row = await repository.getNewsSettings(channelId);
    const current = normalizeSettings(row);
    if (current.customTopics.includes(topic)) {
      updated = row;
      break;
    }
    if (
      current.customTopics.length >= 5 ||
      current.topicCodes.length + current.customTopics.length >= 12
    ) {
      await callTelegram(token, "sendMessage", {
        chat_id: chatId,
        text: "The topic limit was reached. Remove a topic in /settings first.",
      });
      return { auditResult: "Custom topic was not saved because the topic limit was reached." };
    }
    updated = await repository.updateNewsSettings(
      updatePayload(
        current,
        { customTopics: [...current.customTopics, topic] },
        {
          channelId,
          chatId,
          userId,
          version: current.version,
        },
      ),
    );
  }
  if (!updated) {
    throw new Error("News settings changed repeatedly during custom-topic input");
  }
  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: `Custom topic saved: ${topic}\n\n${renderSettingsText(updated)}`,
    reply_markup: telegramMarkup(updated, "home"),
  });
  return { auditResult: `Saved custom topic ${topic}.` };
}
