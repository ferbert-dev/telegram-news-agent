import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramCallAdapter } from "../../src/telegram/transport/telegram-call.adapter.js";
import { TelegramSchedulerNotificationAdapter } from "../../src/scheduler/telegram-scheduler-notification.adapter.js";
import { LegacySchedulerAuditAdapter } from "../../src/scheduler/legacy-scheduler-audit.adapter.js";
import { LegacyTelegramControlAuditAdapter } from "../../src/telegram/legacy-telegram-control-audit.adapter.js";

import type {
  SchedulerAuditApplicationPort,
  SchedulerNotificationApplicationPort,
  SchedulerRunResult,
} from "../../src/scheduler/scheduler-application.contracts.js";
import type { TelegramControlAuditGateway } from "../../src/telegram/telegram-application.contracts.js";

// ---------------------------------------------------------------------------
// Typed Telegram call adapter
// ---------------------------------------------------------------------------

test("typed Telegram call adapter forwards token, method, body and signal unchanged", async () => {
  const calls: unknown[][] = [];
  const adapter = createTelegramCallAdapter(async (...args) => {
    calls.push(args);
    return { message_id: 7 };
  });
  const controller = new AbortController();

  const result = await adapter("token-1", "sendMessage", { chat_id: 5, text: "hi" }, { signal: controller.signal });

  assert.deepEqual(result, { message_id: 7 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["token-1", "sendMessage", { chat_id: 5, text: "hi" }]);
  assert.equal((calls[0][3] as { signal: AbortSignal }).signal, controller.signal);
});

test("typed Telegram call adapter preserves a 409 conflict as a typed error rather than wrapping it", async () => {
  // The polling worker treats HTTP 409 as fatal rather than transient, which
  // only works if status/errorCode survive the adapter untouched.
  const conflict = Object.assign(new Error("Telegram getUpdates failed: Conflict"), {
    name: "TelegramError",
    status: 409,
    errorCode: 409,
  });
  const adapter = createTelegramCallAdapter(async () => {
    throw conflict;
  });

  await assert.rejects(adapter("token-1", "getUpdates", {}), (error) => {
    assert.equal(error, conflict);
    assert.equal((error as { status: number }).status, 409);
    assert.equal((error as { name: string }).name, "TelegramError");
    return true;
  });
});

// ---------------------------------------------------------------------------
// Scheduler notification adapter
// ---------------------------------------------------------------------------

test("scheduler notification adapter sends sendMessage with the chat id and text", async () => {
  const calls: unknown[][] = [];
  const adapter = new TelegramSchedulerNotificationAdapter("token-2", async (...args) => {
    calls.push(args);
    return {};
  });

  await adapter.notify({ chatId: 42, text: "Scheduled article published." });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), [
    "token-2",
    "sendMessage",
    { chat_id: 42, text: "Scheduled article published." },
  ]);
  // No signal supplied means no options object at all, matching the legacy call shape.
  assert.equal(calls[0][3], undefined);
});

test("scheduler notification adapter forwards an abort signal and surfaces delivery failures to its caller", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const forwarding = new TelegramSchedulerNotificationAdapter("token-2", async (_t, _m, _b, options) => {
    seenSignal = options?.signal;
    return {};
  });
  await forwarding.notify({ chatId: 1, text: "x", signal: controller.signal });
  assert.equal(seenSignal, controller.signal);

  // The adapter must not swallow errors itself; RunScheduledNewsOnceUseCase is
  // the one that decides these are best-effort, via its own .catch().
  const failure = new Error("telegram unavailable");
  const failing = new TelegramSchedulerNotificationAdapter("token-2", async () => {
    throw failure;
  });
  await assert.rejects(failing.notify({ chatId: 1, text: "x" }), (error) => error === failure);
});

// ---------------------------------------------------------------------------
// Scheduler Notion audit adapter
// ---------------------------------------------------------------------------

const auditRun = { pageId: "page-1", pageUrl: "https://notion.example/page-1", startedAt: new Date("2026-06-27T00:00:00Z") };
const okResult = { status: "published" } as SchedulerRunResult;

function auditLogger(overrides: Partial<{ start: () => Promise<typeof auditRun>; finish: (run: unknown, f: unknown) => Promise<unknown> }> = {}) {
  return {
    start: overrides.start ?? (async () => auditRun),
    finish: overrides.finish ?? (async () => ({})),
  };
}

test("scheduler audit adapter records a run and returns the operation's own result", async () => {
  const finished: unknown[] = [];
  const adapter = new LegacySchedulerAuditAdapter(
    auditLogger({ finish: async (_run, finalization) => { finished.push(finalization); return {}; } }),
  );

  const result = await adapter.run(
    { channelId: "@channel", scheduleRunId: "run-1", settingsVersion: 3 },
    async () => okResult,
  );

  assert.equal(result, okResult);
  assert.equal(finished.length, 1);
  assert.equal((finished[0] as { status: string }).status, "Succeeded");
});

test("scheduler audit adapter rethrows the operation error unchanged when finalization succeeds", async () => {
  const failure = new Error("pipeline failed");
  const finished: unknown[] = [];
  const adapter = new LegacySchedulerAuditAdapter(
    auditLogger({ finish: async (_run, finalization) => { finished.push(finalization); return {}; } }),
  );

  await assert.rejects(
    adapter.run({ channelId: "@channel", scheduleRunId: "run-1", settingsVersion: 3 }, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal((finished[0] as { status: string }).status, "Failed");
});

test("scheduler audit adapter fails closed: an operation failure plus a finalization failure surface together", async () => {
  const failure = new Error("pipeline failed");
  const auditFailure = new Error("notion unreachable");
  const adapter = new LegacySchedulerAuditAdapter(
    auditLogger({ finish: async () => { throw auditFailure; } }),
  );

  await assert.rejects(
    adapter.run({ channelId: "@channel", scheduleRunId: "run-1", settingsVersion: 3 }, async () => {
      throw failure;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, auditFailure]);
      return true;
    },
  );
});

test("scheduler audit adapter falls back to the durable outbox when success finalization fails", async () => {
  const enqueued: unknown[] = [];
  const adapter = new LegacySchedulerAuditAdapter(
    auditLogger({ finish: async () => { throw new Error("notion unreachable"); } }),
    { async enqueueNotionAuditBackfill(record) { enqueued.push(record); return {}; } },
  );

  // The work already succeeded, so the run must still succeed.
  const result = await adapter.run(
    { channelId: "@channel", scheduleRunId: "run-1", settingsVersion: 3 },
    async () => okResult,
  );

  assert.equal(result, okResult);
  assert.equal(enqueued.length, 1);
  assert.equal((enqueued[0] as { notion_page_id: string }).notion_page_id, "page-1");
  assert.equal((enqueued[0] as { event_type: string }).event_type, "finalize_success");
  assert.match((enqueued[0] as { last_error: string }).last_error, /notion unreachable/);
});

test("scheduler audit adapter rethrows a success finalization failure when no outbox is configured", async () => {
  // Audit loss is never silent.
  const auditFailure = new Error("notion unreachable");
  const adapter = new LegacySchedulerAuditAdapter(
    auditLogger({ finish: async () => { throw auditFailure; } }),
    null,
  );

  await assert.rejects(
    adapter.run({ channelId: "@channel", scheduleRunId: "run-1", settingsVersion: 3 }, async () => okResult),
    (error) => error === auditFailure,
  );
});

// ---------------------------------------------------------------------------
// Telegram control audit adapter
// ---------------------------------------------------------------------------

const controlContext = { updateId: 11, updateKind: "callback_query", routeKind: "review_decision" as never };

test("telegram control audit adapter returns the operation result and logs start plus completion", async () => {
  const logged: string[] = [];
  const adapter = new LegacyTelegramControlAuditAdapter({ info: (message) => logged.push(message) });

  const outcome = await adapter.run(controlContext, async () => ({ status: "completed" }));

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(logged.length, 2);
  const events = logged.map((entry) => JSON.parse(entry) as { event: string; status?: unknown });
  assert.equal(events[0].event, "telegram_control_update_started");
  assert.equal(events[1].event, "telegram_control_update_completed");
  assert.equal(events[1].status, "completed");
});

test("telegram control audit adapter rethrows unchanged and never logs the error message", async () => {
  // Control payloads carry private message content; only a coarse error
  // identity may be audited.
  const failure = new Error("chat 12345 private draft text leaked");
  const logged: string[] = [];
  const adapter = new LegacyTelegramControlAuditAdapter({ info: (message) => logged.push(message) });

  await assert.rejects(
    adapter.run(controlContext, async () => { throw failure; }),
    (error) => error === failure,
  );
  const failureEvent = JSON.parse(logged[1]) as { event: string; error_name: string };
  assert.equal(failureEvent.event, "telegram_control_update_failed");
  assert.equal(failureEvent.error_name, "Error");
  assert.doesNotMatch(logged.join("\n"), /private draft text leaked|12345/);
});

test("telegram control audit adapter cannot let a throwing logger alter the routed outcome", async () => {
  const adapter = new LegacyTelegramControlAuditAdapter({
    info: () => { throw new Error("logger exploded"); },
  });

  assert.deepEqual(await adapter.run(controlContext, async () => ({ status: "completed" })), {
    status: "completed",
  });

  const failure = new Error("route failed");
  await assert.rejects(
    adapter.run(controlContext, async () => { throw failure; }),
    (error) => error === failure,
  );
});

// ---------------------------------------------------------------------------
// Structural proof: these adapters actually satisfy the ports the composition
// root will need. `implements` on the class covers two of them; this covers
// the assignability that matters at the register()/options call sites.
// ---------------------------------------------------------------------------

test("adapters are assignable to the exact ports the composition root requires", () => {
  const call = createTelegramCallAdapter(async () => ({}));

  const notification: SchedulerNotificationApplicationPort =
    new TelegramSchedulerNotificationAdapter("t", call);
  const audit: SchedulerAuditApplicationPort = new LegacySchedulerAuditAdapter(
    { async start() { return auditRun; }, async finish() { return {}; } },
  );
  const controlAudit: TelegramControlAuditGateway = new LegacyTelegramControlAuditAdapter({ info() {} });

  assert.equal(typeof notification.notify, "function");
  assert.equal(typeof audit.run, "function");
  assert.equal(typeof controlAudit.run, "function");
  assert.equal(typeof call, "function");
});
