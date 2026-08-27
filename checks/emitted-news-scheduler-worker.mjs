import assert from "node:assert/strict";

const worker = await import("../dist/scheduler/news-scheduler-worker.js");

assert.equal(worker.NEWS_SCHEDULER_POLL_INTERVAL_MS, 30_000);
assert.equal(worker.NEWS_SCHEDULER_MAX_BACKOFF_MS, 300_000);
assert.equal(typeof worker.runNewsSchedulerLoop, "function");
assert.equal(typeof worker.newsSchedulerBackoffDelay, "function");
assert.equal(typeof worker.schedulerIterationErrorCode, "function");
assert.equal(typeof worker.NewsSchedulerWorker, "function");

const instance = new worker.NewsSchedulerWorker({
  scheduler: { runOnce: async () => ({ status: "idle" }) },
});
assert.equal(instance.name, "news-scheduler");
assert.equal(typeof instance.start, "function");
assert.equal(typeof instance.stop, "function");

// An already-aborted host signal must not start an occurrence under emitted
// NodeNext, and stop() on an unstarted worker must stay quiet.
const aborted = new AbortController();
aborted.abort("emitted-check");
let occurrences = 0;
const guarded = new worker.NewsSchedulerWorker({
  scheduler: {
    runOnce: async () => {
      occurrences += 1;
      return { status: "idle" };
    },
  },
});
await guarded.start(aborted.signal);
await guarded.stop();
assert.equal(occurrences, 0);

assert.equal(
  worker.newsSchedulerBackoffDelay(0),
  worker.NEWS_SCHEDULER_POLL_INTERVAL_MS,
);
assert.ok(
  worker.newsSchedulerBackoffDelay(50, () => 0.999999) <=
    worker.NEWS_SCHEDULER_MAX_BACKOFF_MS,
);
// Jitter sits above the cadence, so even a tiny roll still backs off.
assert.ok(
  worker.newsSchedulerBackoffDelay(1, () => 0.01) >
    worker.NEWS_SCHEDULER_POLL_INTERVAL_MS,
);
assert.equal(worker.schedulerIterationErrorCode(new Error("x")), "scheduler_unavailable");
assert.equal(
  worker.schedulerIterationErrorCode(Object.assign(new Error("x"), { code: "claim_lost" })),
  "claim_lost",
);
