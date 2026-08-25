import assert from "node:assert/strict";
import test from "node:test";

import { TelegramControlError } from "../../src/telegram/telegram-application.contracts.js";
import { TelegramError } from "../../src/telegram.js";
import {
  classifyTelegramUpdate,
  PollingLeaseLostError,
  pollTelegramUpdates,
  retryDelay,
  TelegramPollingWorker,
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

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
        controller.abort("stop-after-retry");
      }
      return [{ update_id: 12, message: { text: "x" } }];
    },
    sleepImpl: async (delayMs, _value, { signal } = {}) => {
      if (delayMs === 60_000) {
        // Keep the fake heartbeat dormant until shutdown. An immediate fake
        // sleep would spin the heartbeat in microtasks and starve the timer
        // which aborts this focused retry test.
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return;
      }
      // Yield to the event loop so the explicit test cancellation can run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(delayMs >= 0 && delayMs <= 500);
    },
    leaseApplication: {
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
    },
    random: () => 0.2,
    heartbeatIntervalMs: 60_000,
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

test("lease loss aborts the transport handler and releases the owner", async () => {
  const controller = new AbortController();
  const heartbeatGate = createDeferred<void>();
  const updates = createUpdatesPersistence();
  let handlerSignal: AbortSignal | undefined;
  let releases = 0;

  await assert.rejects(
    pollTelegramUpdates({
      token: "token",
      leaseName: "telegram-control-poller",
      ownerId: "owner",
      updates: updates.updates,
      transport: {
        handle: async (_update, options) => {
          handlerSignal = options?.signal;
          heartbeatGate.resolve();
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
          return { handled: true };
        },
      },
      callTelegram: async () => [{ update_id: 20, message: { text: "x" } }],
      leaseApplication: {
        acquire: async () => true,
        renew: async () => {
          return false;
        },
        release: async () => {
          releases += 1;
          return true;
        },
      },
      sleepImpl: async (delayMs, _value, { signal } = {}) => {
        if (delayMs === 1) {
          await heartbeatGate.promise;
          return;
        }
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      heartbeatIntervalMs: 1,
      signal: controller.signal,
    }),
    PollingLeaseLostError,
  );

  assert.equal(handlerSignal?.aborted, true);
  assert.equal(releases, 1);
});

test("an unfinished ignored update stays at its offset for redelivery", async () => {
  const controller = new AbortController();
  const updates = createUpdatesPersistence();
  const offsets: number[] = [];
  updates.updates.finishTelegramUpdate = async (payload: unknown) => {
    updates.calls.push({ type: "finish", payload });
    return false;
  };

  await pollTelegramUpdates({
    token: "token",
    leaseName: "telegram-control-poller",
    ownerId: "owner",
    updates: updates.updates,
    transport: { handle: async () => ({ handled: false }) },
    callTelegram: async (_token, _method, payload) => {
      offsets.push(payload.offset as number);
      if (offsets.length === 2) controller.abort("done");
      return [{ update_id: 21, message: { text: "x" } }];
    },
    leaseApplication: {
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
    },
    sleepImpl: async (delayMs, _value, { signal } = {}) => {
      if (delayMs === 60_000) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    heartbeatIntervalMs: 60_000,
    signal: controller.signal,
  });

  assert.deepEqual(offsets, [0, 0]);
  assert.equal(updates.calls.filter((entry) => entry.type === "record").length, 0);
});

test("worker start is ready after lease acquisition, reports a background fatal, and drains once", async () => {
  const fatal = createDeferred<unknown>();
  let releases = 0;
  const worker = new TelegramPollingWorker({
    token: "token",
    ownerId: "owner",
    updates: createUpdatesPersistence().updates,
    transport: { handle: async () => ({ handled: true }) },
    callTelegram: async () => {
      throw new TelegramError("getUpdates", 409, 409, "conflict");
    },
    leaseApplication: {
      acquire: async () => true,
      renew: async () => true,
      release: async () => {
        releases += 1;
        return true;
      },
    },
  });

  await worker.start(new AbortController().signal, async (error) => {
    fatal.resolve(error);
  });
  const error = await fatal.promise;
  assert.equal(error instanceof TelegramError, true);
  await worker.stop();
  await worker.stop();
  assert.equal(releases, 1);
});

test("worker stop before and during start prevents polling and releases a late acquired lease", async () => {
  const before = new TelegramPollingWorker({
    token: "token",
    updates: createUpdatesPersistence().updates,
    transport: { handle: async () => ({ handled: true }) },
    callTelegram: async () => { throw new Error("must not poll"); },
    leaseApplication: { acquire: async () => true, renew: async () => true, release: async () => true },
  });
  await before.stop();
  await before.start(new AbortController().signal);

  const acquire = createDeferred<boolean>();
  let releases = 0;
  const during = new TelegramPollingWorker({
    token: "token",
    ownerId: "owner",
    updates: createUpdatesPersistence().updates,
    transport: { handle: async () => ({ handled: true }) },
    callTelegram: async () => { throw new Error("must not poll"); },
    leaseApplication: {
      acquire: async () => acquire.promise,
      renew: async () => true,
      release: async () => { releases += 1; return true; },
    },
  });
  const starting = during.start(new AbortController().signal);
  const stopping = during.stop();
  acquire.resolve(true);
  await starting;
  await stopping;
  assert.equal(releases, 1);
});

test("two polling workers share the atomic lease port and only one becomes ready", async () => {
  let owner: string | null = null;
  let releases = 0;
  const updates = createUpdatesPersistence().updates;
  const leaseApplication = {
    acquire: async ({ ownerId }: { ownerId: string }) => {
      if (owner !== null) return false;
      owner = ownerId;
      return true;
    },
    renew: async () => true,
    release: async ({ ownerId }: { ownerId: string }) => {
      if (owner === ownerId) {
        owner = null;
        releases += 1;
        return true;
      }
      return false;
    },
  };
  const pendingPoll = async (
    _token: string,
    _method: string,
    _payload: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => new Promise<never>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
      once: true,
    });
  });
  const winner = new TelegramPollingWorker({
    token: "token",
    ownerId: "winner",
    updates,
    transport: { handle: async () => ({ handled: true }) },
    callTelegram: pendingPoll,
    leaseApplication,
  });
  const loser = new TelegramPollingWorker({
    token: "token",
    ownerId: "loser",
    updates,
    transport: { handle: async () => ({ handled: true }) },
    callTelegram: pendingPoll,
    leaseApplication,
    config: { leaseAcquireTimeoutMs: 0 },
  });

  await winner.start(new AbortController().signal);
  await assert.rejects(loser.start(new AbortController().signal), /still holds/);
  await winner.stop();

  assert.equal(owner, null);
  assert.equal(releases, 1);
});
