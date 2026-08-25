import assert from "node:assert/strict";
import test from "node:test";

import { TelegramControlError } from "../../src/telegram/telegram-application.contracts.js";
import { TelegramError } from "../../src/telegram.js";
import {
  classifyTelegramUpdate,
  pollTelegramUpdates,
  retryDelay,
  TelegramUpdateProtocolError,
} from "../../src/telegram/telegram-polling-worker.js";
import type { TelegramUpdateFailureStatus } from "../../src/telegram/telegram-persistence.contracts.js";

const createUpdatesPersistence = () => {
  const calls: Array<{
    type: "claim" | "finish" | "record";
    payload: unknown;
  }> = [];
  return {
    calls,
    updates: {
      claimTelegramUpdate: async (payload: unknown) => {
        calls.push({ type: "claim", payload });
        return {
          claimed: true,
          claim_token: "token-1",
          claim_status: "claimed" as const,
        };
      },
      finishTelegramUpdate: async (payload: unknown) => {
        calls.push({ type: "finish", payload });
        return true;
      },
      recordTelegramUpdateFailure: async (payload: unknown) => {
        calls.push({ type: "record", payload });
        return {
          attempt_count: 1,
          terminal: false,
          failure_status: "failed" as TelegramUpdateFailureStatus,
          recorded: true,
        };
      },
    },
  };
};

test("non-handled update is claimed and finished before advancing offset", async () => {
  const controller = new AbortController();
  const updates = createUpdatesPersistence();
  await pollTelegramUpdates({
    token: "token",
    leaseName: "telegram-control-poller",
    ownerId: "owner",
    updates: updates.updates,
    transport: {
      handle: async () => {
        controller.abort("stop-after-claim");
        return { handled: false };
      },
    },
    callTelegram: async (
      _token: string,
      method: string,
      payload: Record<string, unknown>,
    ) => {
      assert.equal(method, "getUpdates");
      assert.equal(payload.offset, 0);
      return [{ update_id: 10, message: { text: "ok" } }];
    },
    leaseApplication: {
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
    },
    signal: controller.signal,
  });

  assert.equal(
    updates.calls.filter((entry) => entry.type === "claim").length,
    1,
  );
  assert.equal(
    updates.calls.filter((entry) => entry.type === "finish").length,
    1,
  );
  assert.equal(
    updates.calls.filter((entry) => entry.type === "record").length,
    0,
  );
});

test("terminal Telegram control error from transport is handled as completed", async () => {
  const controller = new AbortController();
  const updates = createUpdatesPersistence();
  let callCount = 0;
  const offsets: number[] = [];

  await pollTelegramUpdates({
    token: "token",
    leaseName: "telegram-control-poller",
    ownerId: "owner",
    updates: updates.updates,
    transport: {
      handle: async () => {
        callCount += 1;
        throw new TelegramControlError("forbidden", "No access");
      },
    },
    callTelegram: async (
      _token: string,
      method: string,
      payload: Record<string, unknown>,
    ) => {
      assert.equal(method, "getUpdates");
      offsets.push(payload.offset as number);
      if (callCount > 0) {
        controller.abort();
      }
      return [{ update_id: 11, message: { text: "x" } }];
    },
    leaseApplication: {
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
    },
    signal: controller.signal,
  });

  assert.equal(
    updates.calls.find((entry) => entry.type === "record"),
    undefined,
  );
  assert.deepEqual(offsets, [0, 12]);
});

test("an already stopped worker neither acquires nor releases a polling lease", async () => {
  const controller = new AbortController();
  controller.abort("runtime-stop");
  const calls: string[] = [];

  await pollTelegramUpdates({
    token: "token",
    leaseName: "telegram-control-poller",
    ownerId: "owner",
    updates: createUpdatesPersistence().updates,
    transport: { handle: async () => ({ handled: true }) },
    callTelegram: async () => {
      throw new Error("getUpdates must not run after cancellation");
    },
    leaseApplication: {
      acquire: async () => {
        calls.push("acquire");
        return true;
      },
      renew: async () => true,
      release: async () => {
        calls.push("release");
        return true;
      },
    },
    signal: controller.signal,
  });

  assert.deepEqual(calls, []);
});

test("terminal errors are surfaced from telegram.getUpdates and 409 remains fatal", async () => {
  const controller = new AbortController();
  const updates = createUpdatesPersistence();
  await assert.rejects(
    pollTelegramUpdates({
      token: "token",
      leaseName: "telegram-control-poller",
      ownerId: "owner",
      updates: updates.updates,
      transport: { handle: async () => ({ handled: true }) },
      callTelegram: async () => {
        throw new TelegramError("getUpdates", 409, 409, "conflict");
      },
      leaseApplication: {
        acquire: async () => true,
        renew: async () => true,
        release: async () => true,
      },
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof TelegramError && error.status === 409,
  );
});

test("busy control updates retry with same offset before moving on", async () => {
  const controller = new AbortController();
  const updates = createUpdatesPersistence();
  const offsets: number[] = [];
  let polls = 0;

  await pollTelegramUpdates({
    token: "token",
    leaseName: "telegram-control-poller",
    ownerId: "owner",
    updates: updates.updates,
    transport: {
      handle: async () => {
        throw new TelegramControlError("update_in_progress", "in progress");
      },
    },
    callTelegram: async (
      _token: string,
      method: string,
      payload: Record<string, unknown>,
    ) => {
      assert.equal(method, "getUpdates");
      assert.equal(typeof payload.offset, "number");
      offsets.push(payload.offset as number);
      polls += 1;
      if (polls === 2) {
        setTimeout(() => controller.abort(), 0);
      }
      return [{ update_id: 12, message: { text: "x" } }];
    },
    sleepImpl: async (delayMs) => {
      // full-jitter retry delay should still be bounded and deterministic in this test
      if (delayMs <= 1_000) {
        assert.ok(delayMs >= 0 && delayMs <= 500);
      }
    },
    leaseApplication: {
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
    },
    random: () => 0.2,
    signal: controller.signal,
  });

  assert.deepEqual(offsets, [0, 0]);
  assert.equal(
    updates.calls.find((entry) => entry.type === "record")?.type,
    undefined,
  );
});

test("retry jitter and classification errors remain bounded and stable", () => {
  assert.equal(retryDelay(0, () => 0.999), 499);
  assert.equal(retryDelay(1, () => 0.999), 999);
  const protocolError = (() => {
    try {
      throw new TelegramUpdateProtocolError("invalid");
    } catch (error) {
      return error as TelegramUpdateProtocolError;
    }
  })();
  assert.equal(protocolError.code, "invalid");
  assert.throws(
    () => classifyTelegramUpdate({ callback_query: { id: "x" } }),
    TelegramUpdateProtocolError,
  );
  assert.equal(
    JSON.stringify(
      classifyTelegramUpdate({
        update_id: 5,
        callback_query: { id: "x", data: "aud:v1:ok" },
      }),
    ),
    JSON.stringify({
      updateId: 5,
      kind: "public_feedback",
      terminal: false,
    }),
  );
});
