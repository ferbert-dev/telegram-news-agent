import assert from "node:assert/strict";
import test from "node:test";

import {
  type RuntimeDeadlineFactory,
  type RuntimeSignal,
  RuntimeCoordinator,
  type RuntimeWorker,
} from "../../src/runtime/runtime-coordinator.js";
import {
  DEFAULT_STOP_GRACE_PERIOD_MS,
  MAX_STOP_GRACE_PERIOD_MS,
  RuntimeModule,
} from "../../src/runtime/runtime-module.js";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type SpyWorkerOptions = {
  start?: (signal: AbortSignal) => Promise<void>;
  stop?: () => Promise<void>;
};

const createWorker = (
  name: string,
  events: string[],
  options: SpyWorkerOptions = {},
): RuntimeWorker => ({
  name,
  start: async (signal) => {
    events.push(`${name}.start`);
    await (options.start?.(signal) ?? Promise.resolve());
  },
  stop: async () => {
    events.push(`${name}.stop`);
    await (options.stop?.() ?? Promise.resolve());
  },
});

type SignalHandler = (signal: string) => void;

const createSignalSource = () => {
  const handlers = new Map<string, Set<SignalHandler>>();
  const attach = new Map<string, number>();
  const detach = new Map<string, number>();

  return {
    source: {
      on: (signal: string, handler: SignalHandler): void => {
        const bucket = handlers.get(signal) ?? new Set();
        bucket.add(handler);
        handlers.set(signal, bucket);
        attach.set(signal, (attach.get(signal) ?? 0) + 1);
      },
      off: (signal: string, handler: SignalHandler): void => {
        handlers.get(signal)?.delete(handler);
        detach.set(signal, (detach.get(signal) ?? 0) + 1);
      },
      emit: (signal: string): void => {
        for (const handler of handlers.get(signal) ?? []) {
          handler(signal);
        }
      },
      attachCount: (signal: string) => attach.get(signal) ?? 0,
      detachCount: (signal: string) => detach.get(signal) ?? 0,
      inUse: (signal: string) => (handlers.get(signal)?.size ?? 0) > 0,
    } satisfies RuntimeSignal & {
      emit(signal: string): void;
      attachCount(signal: string): number;
      detachCount(signal: string): number;
      inUse(signal: string): boolean;
    },
  };
};

const createDeferred = (): Deferred & {
  wait: () => Promise<void>;
} => {
  let resolve = () => {};
  let resolved = false;
  const promise = new Promise<void>((resolver) => {
    resolve = () => {
      if (resolved) return;
      resolved = true;
      resolver();
    };
  });
  return {
    promise,
    resolve: () => resolve(),
    wait: () => promise,
  };
};

const createManualDeadline = () => {
  let expire = () => {};
  let created = 0;
  let cancelled = 0;
  const deadlineFactory: RuntimeDeadlineFactory = () => {
    created += 1;
    const expired = new Promise<Error>((resolve) => {
      expire = () => resolve(new Error("runtime shutdown grace period exceeded"));
    });
    return {
      expired,
      cancel: () => {
        cancelled += 1;
      },
    };
  };
  return {
    deadlineFactory,
    expire: () => expire(),
    created: () => created,
    cancelled: () => cancelled,
  };
};

test("RuntimeCoordinator starts and stops workers in deterministic reverse order", async () => {
  const events: string[] = [];
  let appCloseCount = 0;
  const signalSource = createSignalSource();
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      events.push("application.close");
      appCloseCount += 1;
    },
    signalSource: signalSource.source,
    stopGracePeriodMs: 25_000,
    workers: [
      createWorker("first", events),
      createWorker("second", events),
      createWorker("third", events),
    ],
  });

  await coordinator.start();
  await coordinator.close();
  await coordinator.close();

  assert.deepEqual(events, [
    "first.start",
    "second.start",
    "third.start",
    "third.stop",
    "second.stop",
    "first.stop",
    "application.close",
  ]);
  assert.equal(appCloseCount, 1);
  assert.equal(signalSource.source.inUse("SIGINT"), false);
  assert.equal(coordinator.lifecycleState, "stopped");
});

test("RuntimeCoordinator stop during start drains the attempted worker before it finishes starting", async () => {
  const events: string[] = [];
  const startGate = createDeferred();
  const signalSource = createSignalSource();
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      events.push("application.close");
    },
    stopGracePeriodMs: 25_000,
    signalSource: signalSource.source,
    workers: [
      createWorker(
        "first",
        events,
        {
          start: async () => {
            events.push("first.defer");
            await startGate.wait();
          },
        },
      ),
      createWorker("second", events),
    ],
  });

  const startPromise = coordinator.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.includes("first.start"), true);
  assert.equal(events.includes("first.defer"), true);
  signalSource.source.emit("SIGINT");
  startGate.resolve();
  await coordinator.close();
  await startPromise;

  assert.equal(events.includes("second.start"), false);
  assert.equal(events.includes("second.stop"), false);
  assert.equal(events.includes("first.stop"), true);
  assert.equal(signalSource.source.inUse("SIGINT"), false);
});

test("RuntimeCoordinator starts one total shutdown deadline before an uncooperative start settles", async () => {
  const events: string[] = [];
  const startGate = createDeferred();
  const manualDeadline = createManualDeadline();
  let appCloseCount = 0;
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      appCloseCount += 1;
      events.push("application.close");
    },
    deadlineFactory: manualDeadline.deadlineFactory,
    signalSource: createSignalSource().source,
    stopGracePeriodMs: 25_000,
    workers: [
      createWorker("partial", events, {
        start: () => startGate.wait(),
        stop: async () => {
          events.push("partial.stop.latched");
        },
      }),
    ],
  });

  void coordinator.start();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const closePromise = coordinator.close();

  assert.equal(manualDeadline.created(), 1);
  assert.equal(events.includes("partial.stop"), true);
  assert.equal(events.includes("partial.stop.latched"), true);
  manualDeadline.expire();
  await assert.rejects(closePromise, /runtime shutdown grace period exceeded/);
  assert.equal(appCloseCount, 1);
  assert.equal(manualDeadline.cancelled(), 1);
});

test("RuntimeCoordinator rolls back every attempted worker when startup fails", async () => {
  const events: string[] = [];
  let appCloseCount = 0;
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      events.push("application.close");
      appCloseCount += 1;
    },
    stopGracePeriodMs: 25_000,
    signalSource: createSignalSource().source,
    workers: [
      createWorker("ok", events),
      {
        name: "bad",
        start: async () => {
          events.push("bad.start");
          throw new Error("startup crash");
        },
        stop: async () => {
          events.push("bad.stop");
        },
      },
    ],
  });

  await assert.rejects(() => coordinator.start(), /startup crash/);
  assert.deepEqual(events, [
    "ok.start",
    "bad.start",
    "bad.stop",
    "ok.stop",
    "application.close",
  ]);
  assert.equal(appCloseCount, 1);
  assert.equal(coordinator.lifecycleState, "stopped");
});

test("RuntimeCoordinator programmatic close and fatal share one stop promise", async () => {
  const events: string[] = [];
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      events.push("application.close");
    },
    signalSource: createSignalSource().source,
    stopGracePeriodMs: 25_000,
    workers: [createWorker("worker", events)],
  });
  await coordinator.start();

  const closePromise = coordinator.close();
  const fatalPromise = coordinator.reportFatal(new Error("fatal"));
  await closePromise;
  await fatalPromise;

  assert.equal(events.filter((value) => value === "worker.stop").length, 1);
  assert.equal(events.includes("application.close"), true);
  assert.strictEqual(closePromise, fatalPromise);
  assert.equal(coordinator.fatalCause instanceof Error, true);
  assert.equal((coordinator.fatalCause as Error).message, "fatal");
  assert.strictEqual(coordinator.fatalCause, coordinator.fatalCause);
});

test("RuntimeCoordinator gives ready workers a bounded background-fatal reporter", async () => {
  const events: string[] = [];
  let reportFatal: ((error: unknown) => Promise<void>) | undefined;
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      events.push("application.close");
    },
    signalSource: createSignalSource().source,
    stopGracePeriodMs: 25_000,
    workers: [{
      name: "background",
      start: async (_signal, reporter) => {
        reportFatal = reporter;
      },
      stop: async () => {
        events.push("background.stop");
      },
    }],
  });

  await coordinator.start();
  const failure = new Error("background polling failure");
  await reportFatal?.(failure);

  assert.strictEqual(coordinator.fatalCause, failure);
  assert.equal(coordinator.lifecycleState, "stopped");
  assert.deepEqual(events, ["background.stop", "application.close"]);
});

test("RuntimeCoordinator turns first signal into coordinated stop and second into escalation", async () => {
  const events: string[] = [];
  const signalSource = createSignalSource();
  let escalationCalls = 0;
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      events.push("application.close");
    },
    stopGracePeriodMs: 25_000,
    signalSource: signalSource.source,
    workers: [
      createWorker("shutdown", events, {
        stop: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      }),
    ],
    onSecondSignal: async () => {
      events.push("escalate");
      escalationCalls += 1;
    },
  });
  await coordinator.start();

  signalSource.source.emit("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 2));
  signalSource.source.emit("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(escalationCalls, 1);
  assert.equal(events.includes("application.close"), true);
  assert.equal(events.includes("shutdown.stop"), true);
});

test("RuntimeCoordinator keeps stop idempotent under concurrent callers", async () => {
  const events: string[] = [];
  let appCloseCount = 0;
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      appCloseCount += 1;
      events.push("application.close");
    },
    signalSource: createSignalSource().source,
    stopGracePeriodMs: 25_000,
    workers: [createWorker("worker", events)],
  });

  await coordinator.start();
  await Promise.all([
    coordinator.close(),
    coordinator.close(),
    coordinator.reportFatal(new Error("first")),
    coordinator.reportFatal(new Error("second")),
  ]);
  assert.equal(appCloseCount, 1);
});

test("RuntimeCoordinator refuses start without a bound application close callback", async () => {
  const signalSource = createSignalSource();
  const coordinator = new RuntimeCoordinator({
    signalSource: signalSource.source,
    stopGracePeriodMs: 25_000,
    workers: [createWorker("worker", [])],
  });
  await assert.rejects(() => coordinator.start(), /bound application close callback/);
});

test("RuntimeCoordinator bindApplicationClose is one-shot and only while idle", async () => {
  const signalSource = createSignalSource();
  const coordinator = new RuntimeCoordinator({
    signalSource: signalSource.source,
    stopGracePeriodMs: 25_000,
    workers: [createWorker("worker", [])],
    applicationClose: async () => Promise.resolve(),
  });

  await assert.rejects(
    async () => coordinator.bindApplicationClose(async () => {}),
    /already bound|idle state/,
  );

  const firstClose = async () => Promise.resolve();
  const safe = new RuntimeCoordinator({
    signalSource: signalSource.source,
    stopGracePeriodMs: 25_000,
    workers: [createWorker("worker", [])],
    applicationClose: undefined,
  });
  safe.bindApplicationClose(firstClose);
  await safe.start();
  await safe.close();
  assert.equal(safe.lifecycleState, "stopped");

  await assert.rejects(async () => safe.bindApplicationClose(firstClose), /idle state/);
});

test("RuntimeModule validates stop grace period values", async () => {
  assert.doesNotThrow(() =>
    RuntimeModule.register({
      workers: [],
      stopGracePeriodMs: DEFAULT_STOP_GRACE_PERIOD_MS,
      signalSource: createSignalSource().source,
    }),
  );
  assert.throws(
    () =>
      RuntimeModule.register({
        workers: [],
        stopGracePeriodMs: 0,
        signalSource: createSignalSource().source,
      }),
    /stopGracePeriodMs/,
  );
  assert.throws(
    () =>
      RuntimeModule.register({
        workers: [],
        stopGracePeriodMs: MAX_STOP_GRACE_PERIOD_MS,
        signalSource: createSignalSource().source,
      }),
    /stopGracePeriodMs/,
  );
});

test("RuntimeCoordinator timeout still closes the app exactly once", async () => {
  const signalSource = createSignalSource();
  let appCloseCount = 0;
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      appCloseCount += 1;
      await new Promise(() => {
        // intentionally hangs
      });
    },
    signalSource: signalSource.source,
    stopGracePeriodMs: 15,
    workers: [
      createWorker("hung", [], {
        stop: async () => {
          await new Promise(() => {
            // never resolve
          });
        },
      }),
    ],
  });
  await coordinator.start();
  const started = Date.now();
  await assert.rejects(() => coordinator.close(), /runtime shutdown grace period exceeded/);
  assert.equal(appCloseCount, 1);
  assert.ok(Date.now() - started < 120, "shutdown is bounded");
  assert.equal(signalSource.source.inUse("SIGINT"), false);
});

test("RuntimeCoordinator invokes every attempted stop in reverse order before awaiting a hung stop", async () => {
  const events: string[] = [];
  const manualDeadline = createManualDeadline();
  let appCloseCount = 0;
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => {
      appCloseCount += 1;
      events.push("application.close");
    },
    deadlineFactory: manualDeadline.deadlineFactory,
    signalSource: createSignalSource().source,
    stopGracePeriodMs: 25_000,
    workers: [
      createWorker("first", events),
      createWorker("second", events, {
        stop: async () => {
          throw new Error("second stop failed");
        },
      }),
      createWorker("third", events, {
        stop: async () => new Promise<void>(() => {}),
      }),
    ],
  });
  await coordinator.start();

  const closePromise = coordinator.close();
  assert.deepEqual(events.slice(-3), ["third.stop", "second.stop", "first.stop"]);
  manualDeadline.expire();
  await assert.rejects(closePromise, /runtime shutdown grace period exceeded/);
  assert.equal(appCloseCount, 1);
});

test("RuntimeCoordinator starts only once after stop and never reinstalls signal handlers", async () => {
  const signalSource = createSignalSource();
  const coordinator = new RuntimeCoordinator({
    applicationClose: async () => Promise.resolve(),
    signalSource: signalSource.source,
    stopGracePeriodMs: 25_000,
    workers: [createWorker("worker", [])],
  });
  await coordinator.start();
  await coordinator.close();

  await coordinator.start();

  assert.equal(signalSource.source.attachCount("SIGINT"), 1);
  assert.equal(signalSource.source.detachCount("SIGINT"), 1);
  assert.equal(signalSource.source.inUse("SIGINT"), false);
  assert.equal(coordinator.lifecycleState, "stopped");
});
