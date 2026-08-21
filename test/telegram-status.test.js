import assert from "node:assert/strict";
import test from "node:test";
import {
  handleStatusCallback,
  parseStatusCallback,
  parseStatusCommand,
  renderSystemStatus,
  showSystemStatus,
} from "../src/telegram-status.js";

const DASHBOARD = {
  summary: { request_count: "2" },
  posts: [],
  providers: [
    {
      provider: "openai",
      request_count: "2",
      web_search_calls: "0",
      last_success_at: "2026-08-21T12:00:00.000Z",
    },
    {
      provider: "exa",
      request_count: "0",
      web_search_calls: "0",
      last_success_at: "2026-08-20T12:00:00.000Z",
    },
  ],
};

test("status parsing and rendering distinguish idle providers from failures", () => {
  assert.deepEqual(parseStatusCommand("/status@mhonest_bot"), {
    botUsername: "mhonest_bot",
    malformed: false,
  });
  assert.equal(parseStatusCommand("/status extra").malformed, true);
  assert.deepEqual(parseStatusCallback("status:test:exa"), {
    action: "test_exa",
  });
  const text = renderSystemStatus({
    dashboard: DASHBOARD,
    providerNames: ["openai", "gemini", "exa"],
    appVersion: "v0.1.0+abcdef0",
  });
  assert.match(text, /🟢 PostgreSQL · connected/);
  assert.match(text, /🟢 OpenAI · 2 calls today/);
  assert.match(text, /🟡 Gemini · configured/);
  assert.match(text, /🟡 Exa · ready, no calls today/);
  assert.match(text, /idle, not broken/i);
});

test("status display reads PostgreSQL without probing a provider", async () => {
  const calls = [];
  await showSystemStatus({
    token: "token",
    channelId: "@channel",
    chatId: 9,
    repository: {
      async getDailyUsageDashboard() {
        return DASHBOARD;
      },
    },
    callTelegram: async (_token, method, body) => calls.push([method, body]),
    providerNames: ["openai", "gemini", "exa"],
    appVersion: "v0.1.0+abcdef0",
  });
  assert.equal(calls[0][0], "sendMessage");
  assert.match(
    calls[0][1].reply_markup.inline_keyboard[0][0].text,
    /1 search/,
  );
});

test("explicit Exa test records one usage event and enforces cooldown", async () => {
  let searches = 0;
  let usageWrites = 0;
  const calls = [];
  const cooldownStore = new Map();
  const repository = {
    async recordAiUsage(input) {
      usageWrites += 1;
      return { id: "usage-1", ...input };
    },
    async getDailyUsageDashboard() {
      return DASHBOARD;
    },
  };
  const callback = {
    id: "callback-1",
    from: { id: 5 },
    message: { message_id: 7, chat: { id: 9, type: "private" } },
  };
  const dependencies = {
    token: "token",
    channelId: "@channel",
    repository,
    callTelegram: async (_token, method, body) => calls.push([method, body]),
    aiProvider: {
      async testExaConnection() {
        searches += 1;
        return {
          usageEvents: [
            {
              provider: "exa",
              providerResponseId: "exa-health-1",
              model: "exa-search:auto",
              operation: "health_check",
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              webSearchCalls: 1,
              estimatedCostUsd: null,
              pricing: null,
            },
          ],
        };
      },
    },
    providerNames: ["openai", "gemini", "exa"],
    appVersion: "v0.1.0+abcdef0",
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    cooldownStore,
  };
  await handleStatusCallback(callback, { action: "test_exa" }, dependencies);
  await handleStatusCallback(
    { ...callback, id: "callback-2" },
    { action: "test_exa" },
    dependencies,
  );
  assert.equal(searches, 1);
  assert.equal(usageWrites, 1);
  assert.ok(calls.some(([method]) => method === "editMessageText"));
  assert.ok(
    calls.some(
      ([method, body]) =>
        method === "answerCallbackQuery" && /five minutes/i.test(body.text),
    ),
  );
});
