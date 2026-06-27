import assert from "node:assert/strict";
import test from "node:test";
import {
  ensurePollingMode,
  getPollingConfig,
  pollTelegram,
  retryDelay,
} from "../src/telegram-polling.js";

test("polling mode must be explicit", () => {
  assert.throws(() => getPollingConfig({}), /UPDATE_MODE=polling/);
  assert.deepEqual(
    getPollingConfig({
      TELEGRAM_UPDATE_MODE: "polling",
      TELEGRAM_POLLING_MIGRATE_WEBHOOK: "true",
    }),
    { migrateWebhook: true },
  );
});

test("webhook coexistence is refused unless migration is explicit", async () => {
  const calls = [];
  const callTelegram = async (_token, method, body) => {
    calls.push([method, body]);
    return method === "getWebhookInfo" ? { url: "https://example.test/hook" } : true;
  };
  await assert.rejects(
    ensurePollingMode({
      token: "token",
      migrateWebhook: false,
      callTelegram,
    }),
    /webhook is configured/,
  );
  assert.deepEqual(calls.map(([method]) => method), ["getWebhookInfo"]);

  await ensurePollingMode({
    token: "token",
    migrateWebhook: true,
    callTelegram,
  });
  assert.deepEqual(calls.at(-1), [
    "deleteWebhook",
    { drop_pending_updates: false },
  ]);
});

test("retry uses bounded full jitter", () => {
  assert.equal(retryDelay(0, () => 0), 0);
  assert.equal(retryDelay(0, () => 0.999), 499);
  assert.ok(retryDelay(99, () => 0.999) < 30_000);
});

test("polling uses a database lease and exits on cancellation", async () => {
  const calls = [];
  const controller = new AbortController();
  const repository = {
    async acquirePipelineLease() {
      calls.push("acquire");
      return true;
    },
    async releasePipelineLease() {
      calls.push("release");
    },
  };
  await pollTelegram({
    token: "token",
    repository,
    ownerId: "owner",
    callTelegram: async (_token, method) => {
      if (method === "getUpdates") {
        controller.abort();
        return [];
      }
    },
    handleUpdate: async () => {},
    signal: controller.signal,
    log: { error() {} },
  });
  assert.deepEqual(calls, ["acquire", "acquire", "release"]);
});
