import assert from "node:assert/strict";
import test from "node:test";
import {
  createLabsCallback,
  handleLabsCallback,
  parseLabsCallback,
  parseLabsCommand,
  renderClosedLabsText,
  renderLabsKeyboard,
  renderLabsText,
  showLabs,
} from "../src/telegram-labs.js";
import { classifyControlUpdate } from "../src/telegram-control.js";

function feature(state = "off", version = 7) {
  return {
    telegram_channel_id: "@channel",
    feature_key: "article_tags",
    state,
    config: {},
    version,
    updated_by: 5,
  };
}

function callbackFixture({ state = "off", version = 7, stale = false } = {}) {
  const calls = [];
  let rows = [feature(state, version)];
  const repository = {
    async getNewsFeatureFlags() {
      calls.push(["get"]);
      return rows;
    },
    async updateNewsFeatureFlag(payload) {
      calls.push(["update", payload]);
      if (stale || payload.expectedVersion !== rows[0].version) return null;
      rows = [{ ...rows[0], state: payload.state, version: version + 1 }];
      return rows[0];
    },
  };
  const callTelegram = async (_token, method, body) => {
    calls.push([method, body]);
    return true;
  };
  return {
    calls,
    repository,
    callTelegram,
    callback: {
      id: "labs-callback",
      from: { id: 5 },
      message: { message_id: 77, chat: { id: 9, type: "private" } },
    },
    rows: () => rows,
  };
}

test("/labs and versioned callbacks are strictly parsed, addressed, and byte-safe", () => {
  assert.deepEqual(parseLabsCommand("/labs@news_bot"), {
    botUsername: "news_bot",
    malformed: false,
  });
  assert.equal(parseLabsCommand("/lab"), null);
  assert.equal(parseLabsCommand("/laboratory"), null);
  assert.equal(parseLabsCommand("/labs extra").malformed, true);
  assert.equal(
    classifyControlUpdate(
      { message: { text: "/labs@other_bot" } },
      "news_bot",
      100,
    ),
    null,
  );
  assert.deepEqual(
    classifyControlUpdate(
      {
        message: {
          text: "/labs",
          reply_to_message: { message_id: 1, from: { id: 100, is_bot: true } },
          chat: { id: 9, type: "private" },
        },
      },
      "news_bot",
      100,
    ),
    {
      kind: "labs_command",
      command: { botUsername: null, malformed: false },
    },
  );

  const callbacks = [
    ...renderLabsKeyboard([feature()], "home"),
    ...renderLabsKeyboard([feature()], "article_tags"),
  ]
    .flat()
    .map((item) => item.callback_data);
  for (const value of callbacks) {
    assert.ok(Buffer.byteLength(value) <= 64);
    assert.ok(parseLabsCallback(value));
  }
  assert.deepEqual(parseLabsCallback("lab:s:c:7"), {
    action: "state",
    value: "collect",
    version: 7,
  });
  assert.equal(parseLabsCallback("lab:s:x:7"), null);
  assert.equal(parseLabsCallback("lab:s:c:0"), null);
  assert.equal(parseLabsCallback("lab:s:c:7:extra"), null);
  assert.equal(parseLabsCallback(`lab:s:c:${"9".repeat(70)}`), null);
  assert.throws(() => createLabsCallback("state", "unknown", 7));
});

test("Labs home and article detail render all unambiguous states", () => {
  for (const [state, label] of [
    ["off", "Off"],
    ["collect", "Collect only"],
    ["enabled", "Enabled"],
  ]) {
    const rows = [feature(state)];
    assert.match(renderLabsText(rows), new RegExp(`Article tags: ${label}`));
    assert.match(renderLabsText(rows), /Story connections: Planned for V2/);
    assert.match(
      renderLabsKeyboard(rows, "home")[0][0].text,
      new RegExp(`Article tags · ${label}`),
    );
    const detail = renderLabsText(rows, "article_tags");
    assert.match(detail, new RegExp(`Current status: ${label}`));
    assert.match(detail, /Changes take effect immediately/);
    assert.ok(
      renderLabsKeyboard(rows, "article_tags")
        .flat()
        .some((item) => item.text === `✅ ${label}`),
    );
  }
  const allButtons = renderLabsKeyboard([feature()])
    .flat()
    .map((item) => item.text)
    .join(" ");
  assert.doesNotMatch(allButtons, /Story connections/);
  assert.doesNotMatch(allButtons, /Apply/i);
  assert.match(allButtons, /Done & close/);
});

test("showLabs initializes flags and sends the private Labs home", async () => {
  const calls = [];
  const rows = [feature("collect")];
  const result = await showLabs({
    token: "token",
    channelId: "@channel",
    chatId: 9,
    userId: 5,
    repository: {
      async getNewsSettings() {
        calls.push(["get-settings"]);
        return null;
      },
      async getOrCreateNewsSettings(payload) {
        calls.push(["settings", payload]);
        return { telegram_channel_id: payload.channelId };
      },
      async getOrCreateNewsFeatureFlags(payload) {
        calls.push(["create", payload]);
        return rows;
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return { message_id: 77 };
    },
  });

  assert.equal(result.messageId, 77);
  assert.deepEqual(calls[0], ["get-settings"]);
  assert.deepEqual(calls[1], [
    "settings",
    { channelId: "@channel", reviewChatId: 9, updatedBy: 5 },
  ]);
  assert.deepEqual(calls[2][1], { channelId: "@channel", updatedBy: 5 });
  assert.equal(calls[3][0], "sendMessage");
  assert.match(calls[3][1].text, /Article tags: Collect only/);
});

test("showLabs never rewrites an existing news settings owner or review chat", async () => {
  const calls = [];
  await showLabs({
    token: "token",
    channelId: "@channel",
    chatId: 999,
    userId: 88,
    repository: {
      async getNewsSettings(channelId) {
        calls.push(["get-settings", channelId]);
        return {
          telegram_channel_id: channelId,
          review_chat_id: 9,
          updated_by: 5,
          version: 12,
        };
      },
      async getOrCreateNewsSettings() {
        calls.push(["mutated-settings"]);
        throw new Error("existing settings must not be mutated");
      },
      async getOrCreateNewsFeatureFlags(payload) {
        calls.push(["create", payload]);
        return [feature("off")];
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
      return { message_id: 77 };
    },
  });

  assert.equal(calls.some(([name]) => name === "mutated-settings"), false);
  assert.deepEqual(calls[0], ["get-settings", "@channel"]);
  assert.equal(calls.at(-1)[0], "sendMessage");
});

test("article-tags state changes immediately with an optimistic version fence", async () => {
  const flow = callbackFixture({ state: "collect", version: 7 });
  const result = await handleLabsCallback(
    flow.callback,
    parseLabsCallback(createLabsCallback("state", "enabled", 7)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  assert.equal(result.feature.state, "enabled");
  assert.deepEqual(flow.calls.find(([name]) => name === "update")[1], {
    channelId: "@channel",
    featureKey: "article_tags",
    state: "enabled",
    updatedBy: 5,
    expectedVersion: 7,
  });
  const edit = flow.calls.find(([name]) => name === "editMessageText")[1];
  assert.match(edit.text, /Current status: Enabled/);
  assert.ok(
    edit.reply_markup.inline_keyboard
      .flat()
      .some((item) => item.text === "✅ Enabled"),
  );
  assert.match(
    flow.calls.find(([name]) => name === "answerCallbackQuery")[1].text,
    /Active now/,
  );
});

test("stale or missing feature rows alert the admin to reopen /labs", async () => {
  const stale = callbackFixture({ state: "off", version: 8 });
  await handleLabsCallback(
    stale.callback,
    parseLabsCallback(createLabsCallback("state", "enabled", 7)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: stale.repository,
      callTelegram: stale.callTelegram,
    },
  );
  assert.equal(stale.calls.some(([name]) => name === "update"), false);
  assert.equal(stale.calls.some(([name]) => name === "editMessageText"), false);
  const staleAnswer = stale.calls.find(
    ([name]) => name === "answerCallbackQuery",
  )[1];
  assert.match(staleAnswer.text, /Reopen \/labs/);
  assert.equal(staleAnswer.show_alert, true);

  const lostUpdate = callbackFixture({ state: "off", version: 7, stale: true });
  await handleLabsCallback(
    lostUpdate.callback,
    parseLabsCallback(createLabsCallback("state", "enabled", 7)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: lostUpdate.repository,
      callTelegram: lostUpdate.callTelegram,
    },
  );
  assert.equal(lostUpdate.calls.some(([name]) => name === "update"), true);
  assert.equal(
    lostUpdate.calls.some(([name]) => name === "editMessageText"),
    false,
  );
  const lostUpdateAnswer = lostUpdate.calls.find(
    ([name]) => name === "answerCallbackQuery",
  )[1];
  assert.match(lostUpdateAnswer.text, /Reopen \/labs/);
  assert.equal(lostUpdateAnswer.show_alert, true);

  const missingCalls = [];
  await handleLabsCallback(
    stale.callback,
    parseLabsCallback(createLabsCallback("view", "home", 7)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: { async getNewsFeatureFlags() { return []; } },
      callTelegram: async (_token, method, body) => {
        missingCalls.push([method, body]);
      },
    },
  );
  assert.match(missingCalls[0][1].text, /Reopen \/labs/);
  assert.equal(missingCalls[0][1].show_alert, true);
});

test("Done & close removes controls and confirms already-active changes", async () => {
  const flow = callbackFixture({ state: "enabled", version: 7 });
  const result = await handleLabsCallback(
    flow.callback,
    parseLabsCallback(createLabsCallback("close", "done", 7)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  assert.match(result.auditResult, /active/i);
  assert.equal(flow.calls.some(([name]) => name === "update"), false);
  const edit = flow.calls.find(([name]) => name === "editMessageText")[1];
  assert.match(edit.text, /Labs changes are active/);
  assert.match(edit.text, /Article tags: Enabled/);
  assert.doesNotMatch(edit.text, /Apply/i);
  assert.deepEqual(edit.reply_markup, { inline_keyboard: [] });
  assert.match(renderClosedLabsText(flow.rows()), /Send \/labs/);
});

test("an expired callback acknowledgement cannot replay a completed Labs mutation", async () => {
  const flow = callbackFixture({ state: "collect", version: 7 });
  flow.callTelegram = async (_token, method, body) => {
    flow.calls.push([method, body]);
    if (method === "answerCallbackQuery") {
      throw new Error("query is too old");
    }
    return true;
  };

  const result = await handleLabsCallback(
    flow.callback,
    parseLabsCallback(createLabsCallback("state", "enabled", 7)),
    {
      token: "token",
      channelId: "@channel",
      userId: 5,
      repository: flow.repository,
      callTelegram: flow.callTelegram,
    },
  );

  assert.equal(result.feature.state, "enabled");
  assert.equal(
    flow.calls.filter(([name]) => name === "update").length,
    1,
  );
  assert.equal(
    flow.calls.filter(([name]) => name === "editMessageText").length,
    1,
  );
  assert.equal(
    flow.calls.filter(([name]) => name === "answerCallbackQuery").length,
    1,
  );
});
