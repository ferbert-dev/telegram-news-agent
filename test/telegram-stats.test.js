import assert from "node:assert/strict";
import test from "node:test";
import {
  renderUsageDashboard,
  showUsageDashboard,
} from "../src/telegram-stats.js";

const DASHBOARD = {
  summary: {
    request_count: "2",
    input_tokens: "10000",
    cached_input_tokens: "2000",
    output_tokens: "1000",
    reasoning_tokens: "300",
    web_search_calls: "2",
    priced_request_count: "2",
    estimated_cost_usd: "0.05550000",
    published_post_count: "7",
  },
  posts: [
    {
      telegram_message_id: "42",
      published_at: "2026-08-07T10:00:00.000Z",
      editor_name: "Михаил Онест",
      usage_request_count: "2",
      estimated_cost_usd: "0.05550000",
    },
  ],
};

test("usage dashboard shows daily tokens, searches, post cost, and billing caveat", () => {
  const text = renderUsageDashboard(DASHBOARD);
  assert.match(text, /Input tokens: 10,000/);
  assert.match(text, /Web searches: 2/);
  assert.match(text, /Estimated list cost: \$0\.0555/);
  assert.match(text, /Published posts today: 7/);
  assert.match(text, /Latest 1 post costs/);
  assert.match(text, /#42 · 12:00 · Михаил Онест · \$0\.0555/);
  assert.match(text, /actual OpenAI bill may be lower/i);
});

test("showUsageDashboard requests the Europe\/Madrid day and sends one message", async () => {
  const calls = [];
  await showUsageDashboard({
    token: "token",
    channelId: "@channel",
    chatId: 9,
    repository: {
      async getDailyUsageDashboard(payload) {
        calls.push(["dashboard", payload]);
        return DASHBOARD;
      },
    },
    callTelegram: async (_token, method, body) => {
      calls.push([method, body]);
    },
    now: () => new Date("2026-08-07T14:00:00.000Z"),
  });
  assert.equal(calls[0][1].timeZone, "Europe/Madrid");
  assert.equal(calls[1][0], "sendMessage");
  assert.equal(calls[1][1].chat_id, 9);
});
