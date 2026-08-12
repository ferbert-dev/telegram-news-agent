import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTelegramUpdate,
  ensurePollingMode,
  getPollingConfig,
  NonRetryableTelegramUpdateError,
  PollingLeaseLostError,
  pollTelegram,
  retryDelay,
  TelegramUpdatePersistenceError,
  TelegramUpdateProtocolError,
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

test("updates are classified without reading public identities or payload contents", () => {
  assert.deepEqual(
    classifyTelegramUpdate({
      update_id: 1,
      callback_query: { id: "admin", data: "lab:open" },
    }),
    { updateId: 1, kind: "admin_callback", terminal: false },
  );
  assert.deepEqual(
    classifyTelegramUpdate({
      update_id: 2,
      callback_query: { id: "public", data: "aud:v1:more" },
    }),
    { updateId: 2, kind: "public_feedback", terminal: false },
  );
  assert.deepEqual(
    classifyTelegramUpdate({
      update_id: 3,
      message_reaction_count: {
        chat: { id: -1001 },
        message_id: 7,
        date: 1_786_000_000,
        reactions: [],
      },
    }),
    { updateId: 3, kind: "aggregate_reaction", terminal: false },
  );
  assert.deepEqual(
    classifyTelegramUpdate({ update_id: 4, callback_query: {} }),
    {
      updateId: 4,
      kind: "malformed",
      terminal: true,
      errorCode: "invalid_callback_query",
    },
  );
  assert.throws(
    () => classifyTelegramUpdate({ callback_query: { id: "missing-id" } }),
    TelegramUpdateProtocolError,
  );
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

test("failed update is retried from a durable count, quarantined, then acknowledged", async () => {
  const controller = new AbortController();
  const offsets = [];
  const delays = [];
  const failures = new Map();
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
    async recordTelegramUpdateFailure(
      updateId,
      _kind,
      _code,
      maxAttempts,
      terminal,
    ) {
      const attemptCount = (failures.get(updateId) ?? 0) + 1;
      failures.set(updateId, attemptCount);
      const isTerminal = terminal || attemptCount >= maxAttempts;
      return {
        attempt_count: attemptCount,
        terminal: isTerminal,
        failure_status: isTerminal ? "quarantined" : "failed",
        recorded: true,
      };
    },
  };
  await pollTelegram({
    token: "token",
    repository,
    ownerId: "owner",
    callTelegram: async (_token, _method, body) => {
      offsets.push(body.offset);
      if (body.offset === 15) {
        controller.abort();
        return [];
      }
      return [{ update_id: 14 }];
    },
    handleUpdate: async () => {
      throw new Error("crash");
    },
    signal: controller.signal,
    sleepImpl: async (delay) => delays.push(delay),
    random: () => 0.999,
    log: { error() {}, warn() {} },
  });
  assert.deepEqual(offsets, [0, 0, 0, 15]);
  assert.equal(failures.get(14), 3);
  assert.deepEqual(
    delays.filter((delay) => delay !== 20_000),
    [499, 999],
  );
});

test("a malformed poison update is durably quarantined before a later update runs", async () => {
  const controller = new AbortController();
  const offsets = [];
  const handled = [];
  const failures = [];
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
    async recordTelegramUpdateFailure(...args) {
      failures.push(args);
      return {
        attempt_count: 1,
        terminal: true,
        failure_status: "quarantined",
        recorded: true,
      };
    },
  };

  await pollTelegram({
    token: "token",
    repository,
    ownerId: "owner",
    callTelegram: async (_token, _method, body) => {
      offsets.push(body.offset);
      assert.deepEqual(body.allowed_updates, ["message", "callback_query"]);
      if (body.offset === 22) {
        controller.abort();
        return [];
      }
      return [
        { update_id: 20, callback_query: {} },
        { update_id: 21, message: { chat: { id: 1 } } },
      ];
    },
    handleUpdate: async (update) => handled.push(update.update_id),
    signal: controller.signal,
    log: { error() {}, warn() {} },
  });

  assert.deepEqual(offsets, [0, 22]);
  assert.deepEqual(handled, [21]);
  assert.deepEqual(failures, [
    [20, "malformed", "invalid_callback_query", 3, true, null],
  ]);
});

test("an explicitly non-retryable public failure is quarantined once without blocking later updates", async () => {
  const controller = new AbortController();
  const handled = [];
  let recorded;
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
    async recordTelegramUpdateFailure(...args) {
      recorded = args;
      return {
        attempt_count: 1,
        terminal: true,
        failure_status: "quarantined",
        recorded: true,
      };
    },
  };

  await pollTelegram({
    token: "token",
    repository,
    ownerId: "owner",
    callTelegram: async (_token, _method, body) => {
      if (body.offset === 32) {
        controller.abort();
        return [];
      }
      return [
        {
          update_id: 30,
          callback_query: { id: "public", data: "aud:v1:invalid" },
        },
        { update_id: 31, message: {} },
      ];
    },
    handleUpdate: async (update) => {
      if (update.update_id === 30) {
        throw new NonRetryableTelegramUpdateError("invalid_feedback_token");
      }
      handled.push(update.update_id);
    },
    signal: controller.signal,
    log: { error() {}, warn() {} },
  });

  assert.deepEqual(recorded, [
    30,
    "public_feedback",
    "invalid_feedback_token",
    3,
    true,
    null,
  ]);
  assert.deepEqual(handled, [31]);
});

test("an update owned by another worker stays at the same offset without recording a failure", async () => {
  const controller = new AbortController();
  const offsets = [];
  const delays = [];
  let handlerAttempts = 0;
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
    async recordTelegramUpdateFailure() {
      throw new Error("a busy claim must not enter the failure ledger");
    },
  };

  await pollTelegram({
    token: "token",
    repository,
    ownerId: "owner",
    callTelegram: async (_token, _method, body) => {
      offsets.push(body.offset);
      if (body.offset === 61) {
        controller.abort();
        return [];
      }
      return [
        { update_id: 60, callback_query: { id: "admin", data: "news" } },
      ];
    },
    handleUpdate: async () => {
      handlerAttempts += 1;
      if (handlerAttempts === 1) {
        const busy = new Error("Update is already processing");
        busy.code = "update_in_progress";
        throw busy;
      }
    },
    signal: controller.signal,
    sleepImpl: async (delay) => delays.push(delay),
    random: () => 0.999,
    log: { error() {}, warn() {} },
  });

  assert.deepEqual(offsets, [0, 0, 61]);
  assert.equal(handlerAttempts, 2);
  assert.deepEqual(delays.filter((delay) => delay !== 20_000), [499]);
});

test("failure-ledger persistence retries are bounded and fail the poller closed", async () => {
  const controller = new AbortController();
  let records = 0;
  const repository = {
    async acquirePipelineLease() {
      return true;
    },
    async renewPipelineLease() {
      return true;
    },
    async releasePipelineLease() {},
    async recordTelegramUpdateFailure() {
      records += 1;
      throw new Error("database unavailable");
    },
  };

  await assert.rejects(
    pollTelegram({
      token: "token",
      repository,
      ownerId: "owner",
      callTelegram: async () => [{ update_id: 40 }],
      handleUpdate: async () => {
        throw new Error("handler failed");
      },
      signal: controller.signal,
      sleepImpl: async () => {},
      maxFailureLedgerAttempts: 3,
      log: { error() {}, warn() {} },
    }),
    TelegramUpdatePersistenceError,
  );
  assert.equal(records, 3);
});
