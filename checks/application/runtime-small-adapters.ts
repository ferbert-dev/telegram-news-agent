import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramCallAdapter } from "../../src/telegram/transport/telegram-call.adapter.js";
import { TelegramSchedulerNotificationAdapter } from "../../src/scheduler/telegram-scheduler-notification.adapter.js";
import {
  LegacySchedulerAuditAdapter,
  SCHEDULED_RUN_AUDIT_NAME,
  SCHEDULED_RUN_FAILURE_AUDIT_CODE,
} from "../../src/scheduler/legacy-scheduler-audit.adapter.js";
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

/** Records what start() was called with, so title/objective are pinned. */
function recordingAuditLogger(finish: (run: unknown, f: unknown) => Promise<unknown> = async () => ({})) {
  const started: unknown[] = [];
  return {
    started,
    logger: {
      async start(details: unknown) { started.push(details); return auditRun; },
      finish,
    },
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

test("scheduler audit adapter rethrows the operation error unchanged and never uploads its raw message", async () => {
  // Production's legacy caller sanitizes to a constant
  // (withScheduledAudit passes sanitizeError: () => "scheduled_run_failed").
  // Pipeline failures routinely embed provider responses that can contain API
  // keys, plus draft text and chat ids, and this record goes to a third-party
  // Notion workspace.
  const failure = new Error('OpenAI request failed: 401 Incorrect API key provided: sk-proj-SECRET');
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
  assert.equal((finished[0] as { error: string }).error, SCHEDULED_RUN_FAILURE_AUDIT_CODE);
  assert.doesNotMatch(JSON.stringify(finished), /sk-proj-SECRET|Incorrect API key/);
});

test("scheduler audit adapter keeps a constant page title and puts the run id in the objective", () => {
  // Notion board views, rollups and saved filters group scheduled runs by this
  // exact Name; a per-run title would split history into one row per run.
  assert.equal(SCHEDULED_RUN_AUDIT_NAME, "Telegram scheduler - news run");
});

test("scheduler audit adapter records the constant title and a run-identifying objective", async () => {
  const { started, logger } = recordingAuditLogger();
  const adapter = new LegacySchedulerAuditAdapter(logger);

  await adapter.run({ channelId: "@channel", scheduleRunId: "run-77", settingsVersion: 3 }, async () => okResult);

  assert.equal(started.length, 1);
  assert.equal((started[0] as { name: string }).name, SCHEDULED_RUN_AUDIT_NAME);
  assert.match((started[0] as { objective: string }).objective, /run-77/);
  assert.match((started[0] as { objective: string }).objective, /version 3/);
});

test("scheduler audit adapter honors an abort before issuing any Notion write", async () => {
  // Without this, a SIGTERM arriving here still fires two uncancellable Notion
  // HTTP calls and can hold shutdown past compose's 45s stop_grace_period.
  const { started, logger } = recordingAuditLogger();
  const adapter = new LegacySchedulerAuditAdapter(logger);
  const controller = new AbortController();
  const cancellation = new Error("shutting down");
  controller.abort(cancellation);

  let ranOperation = false;
  await assert.rejects(
    adapter.run(
      { channelId: "@channel", scheduleRunId: "run-1", settingsVersion: 3 },
      async () => { ranOperation = true; return okResult; },
      controller.signal,
    ),
    (error) => error === cancellation,
  );
  assert.equal(started.length, 0);
  assert.equal(ranOperation, false);
});

test("an abort before success finalization defers the record to the outbox instead of losing the outcome", async () => {
  const enqueued: unknown[] = [];
  let finishCalls = 0;
  const adapter = new LegacySchedulerAuditAdapter(
    auditLogger({ finish: async () => { finishCalls += 1; return {}; } }),
    { async enqueueNotionAuditBackfill(record) { enqueued.push(record); return {}; } },
  );
  const controller = new AbortController();

  const result = await adapter.run(
    { channelId: "@channel", scheduleRunId: "run-1", settingsVersion: 3 },
    async () => { controller.abort(new Error("shutting down")); return okResult; },
    controller.signal,
  );

  // The work succeeded, so the outcome survives; only its audit is deferred.
  assert.equal(result, okResult);
  assert.equal(finishCalls, 0);
  assert.equal(enqueued.length, 1);
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
  // backfillNotionAudits does `new Date(record.payload.started_at)` and hands
  // `record.payload.finalization` straight to logger.finish, so both keys are
  // a consumed contract, not free-form metadata.
  const payload = (enqueued[0] as { payload: { started_at: string; finalization: { status: string; links: string } } }).payload;
  assert.equal(payload.started_at, auditRun.startedAt.toISOString());
  assert.equal(payload.finalization.status, "Succeeded");
  assert.equal(payload.finalization.links, auditRun.pageUrl);
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
  class ControlError extends Error {
    constructor(message: string) { super(message); this.name = "ControlError"; }
  }
  const failure = new ControlError("chat 12345 private draft text leaked");
  const logged: string[] = [];
  const adapter = new LegacyTelegramControlAuditAdapter({ info: (message) => logged.push(message) });

  await assert.rejects(
    adapter.run(controlContext, async () => { throw failure; }),
    (error) => error === failure,
  );
  const failureEvent = JSON.parse(logged[1]) as Record<string, unknown>;
  assert.equal(failureEvent.event, "telegram_control_update_failed");
  // A subclass makes this load-bearing: error.constructor.name or a wrong
  // field would not produce "ControlError".
  assert.equal(failureEvent.error_name, "ControlError");
  assert.doesNotMatch(logged.join("\n"), /private draft text leaked|12345/);
  // Pin the exact emitted key set, so a future change that spreads richer
  // context (chat id, message text) into the event fails here rather than
  // silently leaking.
  assert.deepEqual(
    Object.keys(failureEvent).sort(),
    ["duration_ms", "error_name", "event", "route_kind", "update_id", "update_kind"],
  );
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
