import assert from "node:assert/strict";
import test from "node:test";
import {
  ensurePollingMode,
  getPollingConfig,
  PollingLeaseLostError,
  pollTelegram,
  retryDelay,
} from "../src/telegram-polling.js";
import { TelegramError } from "../src/telegram.js";

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
  assert.deepEqual(calls, ["acquire", "release"]);
});

test("polling waits for a stale lease and acquires it after expiry", async () => {
  const controller = new AbortController();
  const calls = [];
  let acquisitions = 0;
  const repository = {
    async acquirePipelineLease() {
      acquisitions += 1;
      return acquisitions === 2;
    },
    async releasePipelineLease() {
      calls.push("release");
    },
  };

  await pollTelegram({
    token: "token",
    repository,
    ownerId: "owner",
    callTelegram: async () => {
      controller.abort();
      return [];
    },
    handleUpdate: async () => {},
    signal: controller.signal,
    sleepImpl: async (delay) => calls.push(delay),
    log: { error() {}, warn() {} },
  });

  assert.equal(acquisitions, 2);
  assert.ok(calls.includes(2_000));
  assert.ok(calls.includes("release"));
});

test("lease heartbeat fences a long-running handler and exits on loss", async () => {
  const controller = new AbortController();
  let renewals = 0;
  let handlerSignal;
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      renewals += 1;
      return false;
    },
    async releasePipelineLease() {},
  };
  const immediateSleep = async (_delay, _value, { signal } = {}) => {
    if (signal?.aborted) {
      throw signal.reason;
    }
  };

  await assert.rejects(
    pollTelegram({
      token: "token",
      repository,
      ownerId: "owner",
      callTelegram: async () => [{ update_id: 10 }],
      handleUpdate: async (_update, { signal }) => {
        handlerSignal = signal;
        await new Promise(() => {});
      },
      signal: controller.signal,
      sleepImpl: immediateSleep,
      heartbeatIntervalMs: 1,
      log: { error() {} },
    }),
    PollingLeaseLostError,
  );
  assert.equal(renewals, 1);
  assert.equal(handlerSignal.aborted, true);
});

test("Telegram 409 is fatal instead of retried", async () => {
  const controller = new AbortController();
  let polls = 0;
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
  };
  await assert.rejects(
    pollTelegram({
      token: "token",
      repository,
      ownerId: "owner",
      callTelegram: async () => {
        polls += 1;
        throw new TelegramError("getUpdates", 409, 409, "Conflict");
      },
      handleUpdate: async () => {},
      signal: controller.signal,
      log: { error() {} },
    }),
    (error) => error.status === 409,
  );
  assert.equal(polls, 1);
});

test("failed update is redelivered with the same offset and increasing backoff", async () => {
  const controller = new AbortController();
  const offsets = [];
  const delays = [];
  let polls = 0;
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
  };
  await pollTelegram({
    token: "token",
    repository,
    ownerId: "owner",
    callTelegram: async (_token, _method, body) => {
      offsets.push(body.offset);
      polls += 1;
      if (polls === 3) {
        controller.abort();
      }
      return [{ update_id: 14 }];
    },
    handleUpdate: async () => {
      throw new Error("crash");
    },
    signal: controller.signal,
    sleepImpl: async (delay) => delays.push(delay),
    random: () => 0.999,
    log: { error() {} },
  });
  assert.deepEqual(offsets, [0, 0, 0]);
  assert.deepEqual(
    delays.filter((delay) => delay !== 20_000),
    [499, 999],
  );
});
