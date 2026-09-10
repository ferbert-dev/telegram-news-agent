import assert from "node:assert/strict";
import test from "node:test";

import {
  NEWS_SCHEDULER_MAX_BACKOFF_MS,
  NEWS_SCHEDULER_POLL_INTERVAL_MS,
  NewsSchedulerWorker,
  newsSchedulerBackoffDelay,
  runNewsSchedulerLoop,
  schedulerIterationErrorCode,
} from "../../src/scheduler/news-scheduler-worker.js";
import type {
  RunScheduledNewsOnceInput,
  SchedulerApplicationPort,
  SchedulerRunResult,
} from "../../src/scheduler/scheduler-application.contracts.js";



function makeLog() {
  const info: string[] = [];
  const errors: string[] = [];
  return {
    entries: { info, errors },
    log: {
      info: (message: string) => void info.push(message),
      error: (message: string) => void errors.push(message),
    },
  };
}

function events(messages: string[]): Record<string, unknown>[] {
  return messages.map((message) => JSON.parse(message) as Record<string, unknown>);
}

/** Fake sleep that records requested delays and never actually waits. */
function makeSleep(controller: AbortController, stopAfter: number) {
  const delays: number[] = [];
  let calls = 0;
  return {
    delays,
    sleepImpl: async (
      delayMs: number,
      _value?: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      delays.push(delayMs);
      calls += 1;
      if (options?.signal?.aborted) {
        throw new Error("aborted sleep");
      }
      if (calls >= stopAfter) {
        controller.abort("test-complete");
      }
      return undefined;
    },
  };
}

function schedulerReturning(
  results: (SchedulerRunResult | Error)[],
): SchedulerApplicationPort & { inputs: (RunScheduledNewsOnceInput | undefined)[] } {
  const inputs: (RunScheduledNewsOnceInput | undefined)[] = [];
  let index = 0;
  return {
    inputs,
    runOnce: async (input?: RunScheduledNewsOnceInput) => {
      inputs.push(input);
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("loop runs occurrences at the legacy cadence until aborted", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 3);
  const scheduler = schedulerReturning([{ status: "idle" }]);
  const { entries, log } = makeLog();

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: sleeper.sleepImpl,
    log,
  });

  assert.equal(scheduler.inputs.length, 3);
  assert.deepEqual(sleeper.delays, [
    NEWS_SCHEDULER_POLL_INTERVAL_MS,
    NEWS_SCHEDULER_POLL_INTERVAL_MS,
    NEWS_SCHEDULER_POLL_INTERVAL_MS,
  ]);
  assert.deepEqual(entries.info, [], "idle occurrences must not be logged");
  assert.deepEqual(entries.errors, []);
});

test("the shutdown signal is handed to every occurrence so the use case can cancel", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 1);
  const scheduler = schedulerReturning([{ status: "idle" }]);

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: sleeper.sleepImpl,
  });

  assert.equal(scheduler.inputs[0]?.signal, controller.signal);
});

test("non-idle occurrences are logged with status and settings version", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 1);
  const scheduler = schedulerReturning([
    {
      status: "published",
      draftId: "draft-1",
      settings: { version: 42 } as never,
    },
  ]);
  const { entries, log } = makeLog();

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: sleeper.sleepImpl,
    log,
  });

  assert.deepEqual(events(entries.info), [
    {
      event: "scheduled_news_completed",
      status: "published",
      settings_version: 42,
    },
  ]);
});

test("quiet-hours deferral is a normal occurrence; the worker never re-decides it", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 1);
  const scheduler = schedulerReturning([
    { status: "quiet_hours_deferred", settings: { version: 7 } as never },
  ]);
  const { entries, log } = makeLog();

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: sleeper.sleepImpl,
    log,
  });

  assert.deepEqual(events(entries.info), [
    {
      event: "scheduled_news_completed",
      status: "quiet_hours_deferred",
      settings_version: 7,
    },
  ]);
  assert.deepEqual(entries.errors, []);
});

test("an iteration failure is swallowed, logged and backed off without ending the loop", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 2);
  const scheduler = schedulerReturning([
    new Error("database unavailable"),
    { status: "idle" },
  ]);
  const { entries, log } = makeLog();

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: sleeper.sleepImpl,
    random: () => 1,
    log,
  });

  assert.equal(scheduler.inputs.length, 2, "loop must continue after a failure");
  const [failure] = events(entries.errors);
  assert.equal(failure.event, "news_scheduler_iteration_failed");
  assert.equal(failure.error_code, "scheduler_unavailable");
  assert.equal(failure.consecutive_failures, 1);
  assert.ok(
    (sleeper.delays[0] as number) > NEWS_SCHEDULER_POLL_INTERVAL_MS,
    "a failed occurrence must back off beyond the normal cadence",
  );
  assert.equal(
    sleeper.delays[1],
    NEWS_SCHEDULER_POLL_INTERVAL_MS,
    "a recovered occurrence must return to the normal cadence",
  );
});

test("an abort during an occurrence drains without logging a failure", async () => {
  const controller = new AbortController();
  const { entries, log } = makeLog();
  const scheduler: SchedulerApplicationPort = {
    runOnce: async () => {
      controller.abort("runtime-stop");
      throw new Error("aborted mid-occurrence");
    },
  };

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: async () => {
      throw new Error("sleep must not run after an aborted occurrence");
    },
    log,
  });

  assert.deepEqual(entries.errors, [], "a drain is not an iteration failure");
});

test("an abort raised by the sleep boundary exits cleanly", async () => {
  const controller = new AbortController();
  const scheduler = schedulerReturning([{ status: "idle" }]);

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: async (_delay, _value, options) => {
      controller.abort("runtime-stop");
      void options;
      throw new Error("AbortError");
    },
  });

  assert.equal(scheduler.inputs.length, 1);
});

test("a non-abort sleep failure propagates instead of spinning", async () => {
  const controller = new AbortController();
  const scheduler = schedulerReturning([{ status: "idle" }]);

  await assert.rejects(
    runNewsSchedulerLoop({
      scheduler,
      signal: controller.signal,
      sleepImpl: async () => {
        throw new Error("timer subsystem failed");
      },
    }),
    /timer subsystem failed/,
  );
});

test("backoff stays bounded, never drops below cadence, and grows with failures", () => {
  assert.equal(newsSchedulerBackoffDelay(0), NEWS_SCHEDULER_POLL_INTERVAL_MS);

  for (const failures of [1, 2, 3, 6, 12, 100]) {
    for (const roll of [0, 0.5, 0.999999]) {
      const delay = newsSchedulerBackoffDelay(failures, () => roll);
      assert.ok(
        delay >= NEWS_SCHEDULER_POLL_INTERVAL_MS,
        `delay ${delay} below cadence for ${failures} failures`,
      );
      assert.ok(
        delay <= NEWS_SCHEDULER_MAX_BACKOFF_MS,
        `delay ${delay} above ceiling for ${failures} failures`,
      );
    }
  }

  // Jitter is applied above the cadence, so any non-zero roll is strictly
  // slower than a healthy poll rather than being clamped back onto it.
  for (const failures of [1, 3, 6]) {
    assert.ok(
      newsSchedulerBackoffDelay(failures, () => 0.01) >
        NEWS_SCHEDULER_POLL_INTERVAL_MS,
      `a small roll must still back off at ${failures} failures`,
    );
  }

  // The expected delay must grow as failures accumulate.
  const midRoll = () => 0.5;
  assert.ok(
    newsSchedulerBackoffDelay(3, midRoll) > newsSchedulerBackoffDelay(1, midRoll),
  );
  assert.ok(
    newsSchedulerBackoffDelay(6, midRoll) > newsSchedulerBackoffDelay(3, midRoll),
  );
});

test("backoff scales from the configured poll interval, not the module constant", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 2);
  const scheduler = schedulerReturning([new Error("database unavailable"), { status: "idle" }]);

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    pollIntervalMs: 50,
    sleepImpl: sleeper.sleepImpl,
    random: () => 1,
    log: {},
  });

  // A host configured for a 50ms cadence must not sleep the 30s module default
  // on its failure path. This assertion fails if the constant leaks back in.
  assert.ok(
    (sleeper.delays[0] as number) < NEWS_SCHEDULER_POLL_INTERVAL_MS,
    `configured cadence must drive backoff, got ${sleeper.delays[0]}ms`,
  );
  assert.equal(sleeper.delays[0], 100, "one failure doubles the configured 50ms cadence");
  assert.equal(sleeper.delays[1], 50, "recovery returns to the configured cadence");

  assert.equal(newsSchedulerBackoffDelay(0, Math.random, 50), 50);
  assert.ok(newsSchedulerBackoffDelay(3, () => 0.5, 50) > 50);
  // A cadence above the ceiling must still never go backwards.
  assert.equal(
    newsSchedulerBackoffDelay(4, () => 0.5, NEWS_SCHEDULER_MAX_BACKOFF_MS * 2),
    NEWS_SCHEDULER_MAX_BACKOFF_MS * 2,
  );
});

test("a resolved failure result is surfaced at error level, not only as completed", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 1);
  const scheduler = schedulerReturning([
    {
      status: "failed",
      errorCode: "pipeline_busy",
      settings: { version: 9 } as never,
    },
  ]);
  const { entries, log } = makeLog();

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: sleeper.sleepImpl,
    log,
  });

  // The use case reports in-run failures as a resolved result, so without an
  // error-level line the only signal would be an info "completed" entry.
  assert.deepEqual(events(entries.errors), [
    {
      event: "scheduled_news_failed",
      error_code: "pipeline_busy",
      settings_version: 9,
    },
  ]);
  assert.equal(events(entries.info)[0]?.event, "scheduled_news_completed");
});

test("iteration error codes are stable and never leak error text", () => {
  assert.equal(schedulerIterationErrorCode(undefined), "scheduler_unavailable");
  assert.equal(schedulerIterationErrorCode(new Error("boom")), "scheduler_unavailable");
  assert.equal(
    schedulerIterationErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" })),
    "scheduler_unavailable",
    "upper-case driver codes must not pass through",
  );
  assert.equal(
    schedulerIterationErrorCode(Object.assign(new Error("x"), { code: "claim_lost" })),
    "claim_lost",
  );
});

test("a stopped worker stays stopped; the lifecycle is single-shot", async () => {
  const host = new AbortController();
  let occurrences = 0;
  const worker = new NewsSchedulerWorker({
    scheduler: {
      runOnce: async () => {
        occurrences += 1;
        return { status: "idle" };
      },
    },
    sleepImpl: async () => undefined,
    log: {},
  });

  await worker.start(host.signal);
  await worker.stop();
  const afterStop = occurrences;

  // start() after stop() is a deliberate no-op: stopRequested is never cleared,
  // so the coordinator builds a new instance rather than reviving this one.
  await worker.start(new AbortController().signal);
  assert.equal(occurrences, afterStop, "a stopped worker must not resume");
});

test("a concurrent second start binds to the in-flight readiness", async () => {
  const host = new AbortController();
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let occurrences = 0;
  const worker = new NewsSchedulerWorker({
    scheduler: {
      runOnce: async () => {
        occurrences += 1;
        await gate;
        return { status: "idle" };
      },
    },
    sleepImpl: async () => undefined,
    log: {},
  });

  await worker.start(host.signal);
  await worker.start(host.signal);
  assert.equal(occurrences, 1, "a second start must not open a second loop");

  releaseFirst();
  await worker.stop();
});

test("worker start becomes ready promptly and stop drains the loop once", async () => {
  const host = new AbortController();
  let occurrences = 0;
  let released!: () => void;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  const worker = new NewsSchedulerWorker({
    scheduler: {
      runOnce: async () => {
        occurrences += 1;
        await gate;
        return { status: "idle" };
      },
    },
    sleepImpl: async () => undefined,
    log: {},
  });

  await worker.start(host.signal);
  assert.equal(occurrences, 1, "start must not block on the first occurrence");

  const stopping = worker.stop();
  released();
  await stopping;
  await worker.stop();
});

test("a worker stopped before start never runs an occurrence", async () => {
  const host = new AbortController();
  let occurrences = 0;
  const worker = new NewsSchedulerWorker({
    scheduler: {
      runOnce: async () => {
        occurrences += 1;
        return { status: "idle" };
      },
    },
    sleepImpl: async () => undefined,
    log: {},
  });

  await worker.stop();
  await worker.start(host.signal);

  assert.equal(occurrences, 0);
});

test("an already aborted host signal prevents the loop from starting", async () => {
  const host = new AbortController();
  host.abort("already-stopping");
  let occurrences = 0;
  const worker = new NewsSchedulerWorker({
    scheduler: {
      runOnce: async () => {
        occurrences += 1;
        return { status: "idle" };
      },
    },
    sleepImpl: async () => undefined,
    log: {},
  });

  await worker.start(host.signal);

  assert.equal(occurrences, 0);
});

test("an unexpected loop failure is reported fatal to the coordinator", async () => {
  const host = new AbortController();
  const fatals: unknown[] = [];
  const worker = new NewsSchedulerWorker({
    scheduler: { runOnce: async () => ({ status: "idle" }) },
    sleepImpl: async () => {
      throw new Error("timer subsystem failed");
    },
    log: {},
  });

  await worker.start(host.signal, async (error) => {
    fatals.push(error);
  });
  await worker.stop();

  assert.equal(fatals.length, 1);
  assert.match((fatals[0] as Error).message, /timer subsystem failed/);
});

test("the failure line carries the cause the use case recovered", async () => {
  const controller = new AbortController();
  const sleeper = makeSleep(controller, 1);
  const scheduler = schedulerReturning([
    {
      status: "failed",
      errorCode: "scheduled_run_failed",
      errorCause: "AiProvidersExhaustedError:ai_providers_exhausted",
      settings: { version: 25 } as never,
    },
  ]);
  const { entries, log } = makeLog();

  await runNewsSchedulerLoop({
    scheduler,
    signal: controller.signal,
    sleepImpl: sleeper.sleepImpl,
    log,
  });

  assert.deepEqual(events(entries.errors), [
    {
      event: "scheduled_news_failed",
      error_code: "scheduled_run_failed",
      cause: "AiProvidersExhaustedError:ai_providers_exhausted",
      settings_version: 25,
    },
  ]);
});
