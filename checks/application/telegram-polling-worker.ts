import assert from "node:assert/strict";
import test from "node:test";

import { TelegramControlError } from "../../src/telegram/telegram-application.contracts.js";
import { HandleTelegramControlUpdateUseCase } from "../../src/telegram/application/handle-telegram-control-update.use-case.js";
import { TelegramBotApiOutcomeRenderer } from "../../src/telegram/transport/telegram-bot-api.gateway.js";
import { TelegramControlTransportHandler } from "../../src/telegram/transport/telegram-control-transport.handler.js";
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

test("lease loss fences the real poller control route before Bot API presentation", async () => {
  const controller = new AbortController();
  const heartbeatGate = createDeferred<void>();
  const routeGate = createDeferred<void>();
  const updates = createUpdatesPersistence();
  let botCalls = 0;
  let releases = 0;
  const application = new HandleTelegramControlUpdateUseCase(
    updates.updates,
    { async isChannelAdmin() { return true; } },
    { async run(_context, operation) { return operation(); } },
    {
      async execute(_request, _claimToken, signal) {
        heartbeatGate.resolve();
        signal?.addEventListener("abort", () => routeGate.resolve(), { once: true });
        await routeGate.promise;
        return { status: "no_candidates" };
      },
    },
    { async execute() { throw new Error("unused review"); } },
    { async execute() { throw new Error("unused settings"); } },
    { async execute() { throw new Error("unused labs"); } },
    { async execute() { throw new Error("unused stats"); } },
    { async execute() { throw new Error("unused status"); } },
  );
  const transport = new TelegramControlTransportHandler(
    { handle: (request, present, signal) => application.execute(request, present, signal) },
    new TelegramBotApiOutcomeRenderer("token", async () => {
      botCalls += 1;
      return { message_id: 1 };
    }),
    { botUsername: "honest_bot", botId: 77, channelId: "@channel" },
  );

  await assert.rejects(
    pollTelegramUpdates({
      token: "token", leaseName: "telegram-control-poller", ownerId: "owner",
      updates: updates.updates, transport,
      callTelegram: async () => [{
        update_id: 22,
        message: { text: "/news", from: { id: 9 }, chat: { id: 10, type: "private" } },
      }],
      leaseApplication: {
        acquire: async () => true,
        renew: async () => false,
        release: async () => { releases += 1; return true; },
      },
      sleepImpl: async (delayMs, _value, { signal } = {}) => {
        if (delayMs === 1) return heartbeatGate.promise;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      heartbeatIntervalMs: 1,
      signal: controller.signal,
    }),
    PollingLeaseLostError,
  );
  assert.equal(botCalls, 0);
  assert.equal(releases, 1);
  assert.equal(updates.calls.filter((entry) => entry.type === "finish").length, 1);
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

test("own AbortError during lease, poll, and update retry sleeps completes cleanly", async () => {
  const abortingSleep = (controller: AbortController) => async () => {
    controller.abort("runtime-stop");
    throw new DOMException("aborted", "AbortError");
  };

  const leaseController = new AbortController();
  await pollTelegramUpdates({
    token: "token", leaseName: "telegram-control-poller", ownerId: "lease",
    updates: createUpdatesPersistence().updates,
    transport: { handle: async () => ({ handled: true }) },
    callTelegram: async () => { throw new Error("must not poll"); },
    leaseApplication: { acquire: async () => false, renew: async () => true, release: async () => true },
    sleepImpl: abortingSleep(leaseController), signal: leaseController.signal,
  });

  for (const mode of ["poll", "update"] as const) {
    const controller = new AbortController();
    let releases = 0;
    const updates = createUpdatesPersistence();
    await pollTelegramUpdates({
      token: "token", leaseName: "telegram-control-poller", ownerId: mode,
      updates: updates.updates,
      transport: { handle: async () => {
        if (mode === "update") throw new Error("retry update");
        return { handled: true };
      } },
      callTelegram: async () => {
        if (mode === "poll") throw new Error("retry poll");
        return [{ update_id: 22, message: { text: "x" } }];
      },
      leaseApplication: {
        acquire: async () => true, renew: async () => true,
        release: async () => { releases += 1; return true; },
      },
      sleepImpl: abortingSleep(controller), signal: controller.signal,
    });
    assert.equal(releases, 1);
  }
});
