import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsCallback,
  handleSettingsCallback,
  handleSettingsInput,
  isSettingsInputReply,
  parseSettingsCallback,
  parseSettingsCommand,
  renderAppliedSettingsText,
  renderSettingsKeyboard,
  renderSettingsText,
  showSettings,
} from "../src/telegram-settings.js";
import {
  classifyControlUpdate,
  handleControlUpdate,
} from "../src/telegram-control.js";

const BASE_ROW = Object.freeze({
  telegram_channel_id: "@channel",
  review_chat_id: 9,
  schedule_interval_minutes: null,
  language_code: "en",
  topic_codes: ["world", "science", "nature", "animals"],
  custom_topics: [],
  excluded_topic_codes: ["war_conflict"],
  approval_policy: "manual",
  quiet_hours_enabled: true,
  next_run_at: null,
  version: 3,
});

function updatedRow(payload, version = payload.expectedVersion + 1) {
  return {
    telegram_channel_id: payload.channelId,
    review_chat_id: payload.reviewChatId,
    schedule_interval_minutes: payload.scheduleIntervalMinutes,
    language_code: payload.languageCode,
    topic_codes: payload.topicCodes,
    custom_topics: payload.customTopics,
    excluded_topic_codes: payload.excludedTopicCodes ?? ["war_conflict"],
    approval_policy: payload.approvalPolicy,
    quiet_hours_enabled: payload.quietHoursEnabled,
    next_run_at: null,
    version,
  };
}

function callbackFixture(overrides = {}) {
  const calls = [];
  let row = { ...BASE_ROW };
  const repository = {
    async getNewsSettings() {
      return row;
    },
    async updateNewsSettings(payload) {
      calls.push(["update", payload]);
      if (overrides.stale || payload.expectedVersion !== row.version) {
        return null;
      }
      row = updatedRow(payload);
      return row;
    },
    async updateNewsExcludedTopics(payload) {
      calls.push(["updateExcluded", payload]);
      if (overrides.stale || payload.expectedVersion !== row.version) {
        return null;
      }
      row = {
        ...row,
        excluded_topic_codes: payload.excludedTopicCodes,
        version: row.version + 1,
      };
      return row;
    },
    async beginTelegramSettingsInput(payload) {
      calls.push(["beginInput", payload]);
      return payload;
    },
    ...overrides.repository,
  };
  const callTelegram = async (_token, method, body) => {
    calls.push([method, body]);
    if (method === "sendMessage") return { message_id: 88 };
    return true;
  };
  const callback = {
    id: "callback-1",
    from: { id: 5 },
    message: { message_id: 77, chat: { id: 9, type: "private" } },
  };
  return {
    calls,
    callback,
    repository,
    callTelegram,
    row: () => row,
  };
}

test("/settings and compact callbacks are strictly parsed and bounded", () => {
  assert.deepEqual(parseSettingsCommand("/settings@news_bot"), {
    botUsername: "news_bot",
    malformed: false,
  });
  assert.equal(parseSettingsCommand("/setting"), null);
  assert.equal(parseSettingsCommand("/settings extra").malformed, true);

  const callbacks = renderSettingsKeyboard(BASE_ROW, "topics")
    .flat()
    .map((item) => item.callback_data);
  for (const value of callbacks) {
    assert.ok(Buffer.byteLength(value) <= 64);
    assert.ok(parseSettingsCallback(value));
  }
  assert.deepEqual(parseSettingsCallback("cfg:l:uk:3"), {
    action: "language",
    value: "uk",
    version: 3,
  });
  assert.equal(parseSettingsCallback("cfg:l:fr:3"), null);
  assert.equal(parseSettingsCallback("cfg:i:5:3"), null);
  assert.deepEqual(parseSettingsCallback("cfg:i:180:3"), {
    action: "interval",
    value: 180,
    version: 3,
  });
  assert.equal(parseSettingsCallback(`cfg:l:en:${"9".repeat(70)}`), null);
  assert.deepEqual(parseSettingsCallback("cfg:s:ok:3"), {
    action: "status",
    value: "applied",
    version: 3,
  });
  assert.deepEqual(parseSettingsCallback("cfg:x:w:3"), {
    action: "excluded_toggle",
    value: "war_conflict",
    version: 3,
  });
});

test("home UI presents settings including the active night pause", () => {
  const keyboard = renderSettingsKeyboard(BASE_ROW, "home");
  assert.deepEqual(
    keyboard.map((row) => row[0].text),
    [
      "1 · Language",
      "2 · Topics",
      "3 · Custom topics",
      "4 · Publishing",
      "5 · Frequency",
      "6 · Night pause · Enabled",
      "7 · Excluded topics · 1",
      "✅ Apply & close settings",
    ],
  );
  assert.equal(keyboard.at(-1)[0].style, "success");
  const text = renderSettingsText(BASE_ROW);
  assert.match(text, /Language: English/);
  assert.match(text, /Publishing: Review required/);
  assert.match(text, /Frequency: Paused/);
  assert.match(text, /Night pause: Enabled \(22:00–08:00 Europe\/Madrid\)/);
  assert.match(text, /Excluded-topic preference: War & armed conflict/);
  assert.match(text, /Settings saved and active/);
  assert.match(text, /Each change is applied immediately/);
});

test("showSettings persists the review chat and sends the inline UI", async () => {
  const calls = [];
  const result = await showSettings({
    token: "token",
    channelId: "@channel",
    chatId: 9,
    userId: 5,
    repository: {
      async getOrCreateNewsSettings(payload) {
        calls.push(["create", payload]);
        return BASE_ROW;
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return { message_id: 77 };
    },
  });

  assert.equal(result.messageId, 77);
  assert.deepEqual(calls[0][1], {
    channelId: "@channel",
    reviewChatId: 9,
    updatedBy: 5,
  });
  assert.equal(calls[1][0], "sendMessage");
  assert.equal(calls[1][1].reply_markup.inline_keyboard.length, 8);
});

test("excluded-topic toggle is localized in EN, UK, and DE and callbacks stay compact", () => {
  const labels = {
    en: "War & armed conflict",
    uk: "Війна та збройні конфлікти",
    de: "Krieg und bewaffnete Konflikte",
  };
  for (const [language, label] of Object.entries(labels)) {
    const keyboard = renderSettingsKeyboard(
      { ...BASE_ROW, language_code: language },
      "excluded",
    );
    const toggle = keyboard[0][0];
    assert.equal(toggle.text, `✅ ${label}`);
    assert.ok(Buffer.byteLength(toggle.callback_data) <= 64);
    assert.deepEqual(parseSettingsCallback(toggle.callback_data), {
      action: "excluded_toggle",
      value: "war_conflict",
      version: 3,
    });
  }
});

test("excluded-topic mutation uses its dedicated CAS and stale callbacks refresh", async () => {
  const flow = callbackFixture();
  const result = await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("excluded_toggle", "war_conflict", 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  assert.match(result.auditResult, /excluded topic/i);
  assert.deepEqual(
    flow.calls.find(([name]) => name === "updateExcluded")[1],
    {
      channelId: "@channel",
      excludedTopicCodes: [],
      updatedBy: 5,
      expectedVersion: 3,
    },
  );
  assert.equal(flow.calls.some(([name]) => name === "update"), false);
  assert.deepEqual(flow.row().excluded_topic_codes, []);
  const edit = flow.calls.find(([name]) => name === "editMessageText")[1];
  assert.match(edit.text, /Excluded-topic preference: None/);
  assert.match(edit.text, /does not replace manual review/i);

  const stale = callbackFixture({ stale: true });
  const staleResult = await handleSettingsCallback(
    stale.callback,
    parseSettingsCallback(createSettingsCallback("excluded_toggle", "war_conflict", 2)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: stale.repository,
      callTelegram: stale.callTelegram,
    },
  );
  assert.match(staleResult.auditResult, /stale/i);
  assert.equal(
    stale.calls.find(([name]) => name === "answerCallbackQuery")[1].show_alert,
    true,
  );
});

test("night pause can be disabled explicitly and remains versioned", async () => {
  const flow = callbackFixture();
  const parsed = parseSettingsCallback(
    createSettingsCallback("quiet", "disabled", 3),
  );

  await handleSettingsCallback(flow.callback, parsed, {
    token: "token",
    channelId: "@channel",
    userId: 5,
    repository: flow.repository,
    callTelegram: flow.callTelegram,
  });

  const payload = flow.calls.find(([name]) => name === "update")[1];
  assert.equal(payload.quietHoursEnabled, false);
  assert.equal(payload.expectedVersion, 3);
  assert.equal(flow.row().quiet_hours_enabled, false);
  const edit = flow.calls.find(([name]) => name === "editMessageText")[1];
  assert.match(edit.text, /Night pause: Disabled/);
  assert.equal(edit.reply_markup.inline_keyboard[1][0].text, "✅ Disabled");
});

test("applied status button replaces controls with an applied summary", async () => {
  const flow = callbackFixture();
  const result = await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("status", "applied", 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  assert.match(result.auditResult, /closed/i);
  const edit = flow.calls.find(([name]) => name === "editMessageText")[1];
  assert.match(edit.text, /^✅ Settings applied/);
  assert.match(edit.text, /Language: English/);
  assert.match(edit.text, /Topics: World events, Science and discoveries/);
  assert.deepEqual(edit.reply_markup, { inline_keyboard: [] });
  assert.equal(
    flow.calls.find(([name]) => name === "answerCallbackQuery")[1].text,
    "Settings applied. Menu closed.",
  );
  assert.match(renderAppliedSettingsText(BASE_ROW), /Send \/settings/);
});

test("language mutation is explicit, versioned, redraws, and answers callback", async () => {
  const flow = callbackFixture();
  const parsed = parseSettingsCallback(createSettingsCallback("language", "uk", 3));
  await handleSettingsCallback(flow.callback, parsed, {
    token: "token",
    channelId: "@channel",
    userId: 5,
    repository: flow.repository,
    callTelegram: flow.callTelegram,
  });

  const payload = flow.calls.find(([name]) => name === "update")[1];
  assert.equal(payload.languageCode, "uk");
  assert.equal(payload.expectedVersion, 3);
  assert.equal(payload.reviewChatId, 9);
  assert.equal(flow.row().version, 4);
  assert.match(
    flow.calls.find(([name]) => name === "editMessageText")[1].text,
    /Language: Ukrainian/,
  );
  assert.equal(
    flow.calls.filter(([name]) => name === "answerCallbackQuery").length,
    1,
  );
});

test("stale mutation does not toggle state and refreshes the latest settings", async () => {
  const flow = callbackFixture({ stale: true });
  const parsed = parseSettingsCallback(createSettingsCallback("interval", 360, 2));
  const result = await handleSettingsCallback(flow.callback, parsed, {
    token: "token",
    channelId: "@channel",
    userId: 5,
    repository: flow.repository,
    callTelegram: flow.callTelegram,
  });

  assert.match(result.auditResult, /stale/i);
  const answer = flow.calls.find(([name]) => name === "answerCallbackQuery")[1];
  assert.match(answer.text, /refreshed/i);
  assert.equal(answer.show_alert, true);
  assert.equal(flow.row().schedule_interval_minutes, null);
});

test("stale rapid tap completes when Telegram says the refreshed menu is unchanged", async () => {
  const flow = callbackFixture({ stale: true });
  const callTelegram = async (token, method, body) => {
    flow.calls.push([method, body]);
    if (method === "editMessageText") {
      throw new Error(
        "Telegram editMessageText failed: Bad Request: message is not modified",
      );
    }
    return flow.callTelegram(token, method, body);
  };

  const result = await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("interval", 60, 2)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram,
    },
  );

  assert.match(result.auditResult, /stale/i);
  assert.equal(
    flow.calls.find(([name]) => name === "answerCallbackQuery")[1].text,
    "Settings changed elsewhere; refreshed.",
  );
});

test("frequency cannot be re-enabled while publication reconciliation is pending", async () => {
  const flow = callbackFixture({
    repository: {
      async getNewsSettings() {
        return {
          ...BASE_ROW,
          last_run_status: "publication_unresolved",
          schedule_draft_id: "draft-unresolved",
        };
      },
      async getDraft() {
        return { id: "draft-unresolved", status: "publishing" };
      },
    },
  });
  const result = await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("interval", 360, 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  assert.match(result.auditResult, /unresolved/i);
  assert.equal(flow.calls.some(([name]) => name === "update"), false);
  const answer = flow.calls.find(([name]) => name === "answerCallbackQuery")[1];
  assert.match(answer.text, /reconcile/i);
  assert.equal(answer.show_alert, true);
});

test("frequency can resume the checkpoint after confirmed not-sent reconciliation", async () => {
  const flow = callbackFixture({
    repository: {
      async getNewsSettings() {
        return {
          ...BASE_ROW,
          last_run_status: "publication_unresolved",
          schedule_draft_id: "draft-reconciled",
        };
      },
      async getDraft() {
        return { id: "draft-reconciled", status: "approved" };
      },
    },
  });
  await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("interval", 360, 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  assert.equal(
    flow.calls.find(([name]) => name === "update")[1]
      .scheduleIntervalMinutes,
    360,
  );
});

test("automatic publishing requires a confirmation page and an explicit set", async () => {
  const flow = callbackFixture();
  await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("view", "automatic", 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );
  assert.equal(flow.calls.some(([name]) => name === "update"), false);
  assert.match(
    flow.calls.find(([name]) => name === "editMessageText")[1].text,
    /without review/,
  );

  await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("approval", "automatic", 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );
  assert.equal(flow.row().approval_policy, "automatic");
  const approvalKeyboard = renderSettingsKeyboard(flow.row(), "approval");
  assert.equal(approvalKeyboard[1][0].text, "Auto-publish: Enabled ⚠️");
  const automaticKeyboard = renderSettingsKeyboard(flow.row(), "automatic");
  assert.equal(automaticKeyboard[0][0].text, "Disable auto-publish");
});

test("next run is displayed in Europe/Madrid with daylight-saving time", () => {
  const text = renderSettingsText({
    ...BASE_ROW,
    schedule_interval_minutes: 360,
    next_run_at: "2026-08-07T14:30:00.000Z",
  });
  assert.match(text, /Next run \(Europe\/Madrid\):/);
  assert.match(text, /16:30/);
  assert.match(text, /CEST/);
  assert.doesNotMatch(text, /2026-08-07T14:30:00\.000Z/);
});

test("frequency page marks the currently applied interval", () => {
  const active = renderSettingsKeyboard(
    { ...BASE_ROW, schedule_interval_minutes: 180 },
    "frequency",
  );
  assert.equal(active[0][1].text, "✅ Every 3 hours");
  assert.equal(active[1][0].text, "Every 6 hours");
  assert.equal(active[2][0].text, "Every 24 hours");
  assert.equal(active[3][0].text, "Pause automatic search");

  const paused = renderSettingsKeyboard(BASE_ROW, "frequency");
  assert.equal(paused[3][0].text, "✅ Pause automatic search");
});

test("three-hour frequency is saved and applied immediately", async () => {
  const flow = callbackFixture();

  await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("interval", 180, 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  const payload = flow.calls.find(([name]) => name === "update")[1];
  assert.equal(payload.scheduleIntervalMinutes, 180);
  assert.equal(flow.row().schedule_interval_minutes, 180);
  const edit = flow.calls.find(([name]) => name === "editMessageText")[1];
  assert.match(edit.text, /Frequency: Every 3 hours/);
  assert.equal(edit.reply_markup.inline_keyboard[0][1].text, "✅ Every 3 hours");
});

test("selected topics use Telegram's native pill color styles", () => {
  const keyboard = renderSettingsKeyboard(BASE_ROW, "topics");
  const buttons = keyboard.flat();
  assert.equal(
    buttons.find(({ text }) => text.includes("World events")).style,
    "primary",
  );
  assert.equal(
    buttons.find(({ text }) => text.includes("Technology and innovation")).style,
    undefined,
  );
  assert.equal(
    buttons.find(({ text }) => text.includes("Broad mix")).style,
    undefined,
  );
});

test("custom topic prompt uses ForceReply and persists an exact expiring binding", async () => {
  const flow = callbackFixture();
  await handleSettingsCallback(
    flow.callback,
    parseSettingsCallback(createSettingsCallback("custom_prompt", "set", 3)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
      now: () => new Date("2026-08-07T08:00:00Z"),
    },
  );

  const prompt = flow.calls.find(([name]) => name === "sendMessage")[1];
  assert.equal(prompt.reply_markup.force_reply, true);
  assert.deepEqual(flow.calls.find(([name]) => name === "beginInput")[1], {
    controlChatId: 9,
    requestedBy: 5,
    promptMessageId: 88,
    expiresAt: "2026-08-07T08:15:00.000Z",
  });
  assert.equal(
    flow.calls.filter(([name]) => name === "answerCallbackQuery").length,
    1,
  );
});

test("custom topic input is bound, normalized, consumed once, and saved", async () => {
  const calls = [];
  let row = { ...BASE_ROW };
  const repository = {
    async consumeTelegramSettingsInput(payload) {
      calls.push(["consume", payload]);
      return { prompt_message_id: 88 };
    },
    async getNewsSettings() {
      return row;
    },
    async updateNewsSettings(payload) {
      calls.push(["update", payload]);
      row = updatedRow(payload);
      return row;
    },
  };
  const message = {
    text: "  marine   biology  ",
    from: { id: 5 },
    chat: { id: 9, type: "private" },
    reply_to_message: {
      message_id: 88,
      from: { id: 100, is_bot: true },
    },
  };
  await handleSettingsInput(message, {
    token: "token",
    channelId: "@channel",
    userId: 5,
    repository,
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return { message_id: 99 };
    },
  });

  assert.deepEqual(calls.find(([name]) => name === "consume")[1], {
    controlChatId: 9,
    requestedBy: 5,
    promptMessageId: 88,
  });
  assert.deepEqual(row.custom_topics, ["marine biology"]);
  assert.match(
    calls.find(([name]) => name === "sendMessage")[1].text,
    /Custom topic saved: marine biology/,
  );
});

test("only a private reply to this bot is classified as settings input", () => {
  const message = {
    text: "Animals",
    chat: { id: 9, type: "private" },
    reply_to_message: { message_id: 88, from: { id: 100, is_bot: true } },
  };
  assert.equal(isSettingsInputReply(message, 100), true);
  assert.equal(isSettingsInputReply(message, 101), false);
  assert.deepEqual(
    classifyControlUpdate({ message }, "news_bot", 100),
    { kind: "settings_input" },
  );
  assert.deepEqual(
    classifyControlUpdate(
      { message: { ...message, text: "/settings" } },
      "news_bot",
      100,
    ).kind,
    "settings_command",
  );
});

test("/settings is private and admin-only before any configuration mutation", async () => {
  let created = false;
  const repository = {
    async claimTelegramUpdate() {
      return { claimed: true, claim_token: "claim", claim_status: "claimed" };
    },
    async finishTelegramUpdate() {
      return true;
    },
    async getOrCreateNewsSettings() {
      created = true;
      return BASE_ROW;
    },
    async enqueueNotionAuditFinalization() {},
  };
  const auditLogger = {
    async start() {
      return { pageUrl: "https://notion.test/run", startedAt: new Date() };
    },
    async finish() {},
  };
  await assert.rejects(
    handleControlUpdate(
      {
        update_id: 50,
        message: {
          text: "/settings",
          from: { id: 5 },
          chat: { id: 9, type: "private" },
        },
      },
      {
        botUsername: "news_bot",
        botId: 100,
        token: "token",
        channelId: "@channel",
        repository,
        auditLogger,
        callTelegram: async (_token, method) =>
          method === "getChatMember" ? { status: "member" } : true,
      },
    ),
    (error) => error.code === "forbidden",
  );
  assert.equal(created, false);
});
