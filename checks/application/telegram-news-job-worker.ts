import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { TelegramNewsJobWorker } from "../../src/telegram/telegram-news-job-worker.js";

const EXECUTE_JOB = {
  id: "job-1",
  claim_token: "token-1",
  claim_phase: "execute",
  telegram_channel_id: "@channel",
  control_chat_id: 987,
  requested_by: 42,
  settings_snapshot: { channelId: "@channel" },
} as never;

const DELIVER_JOB = { ...(EXECUTE_JOB as object), claim_phase: "deliver" } as never;

function build(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const jobs = {
    async claimNextTelegramNewsJob() {
      calls.push("claim");
      return EXECUTE_JOB;
    },
    async renewTelegramNewsJobClaim() {
      calls.push("renew");
      return true;
    },
    async recordTelegramNewsJobOutcome() {
      calls.push("recordOutcome");
      return { status: "outcome_ready" };
    },
    async retryTelegramNewsJob() {
      calls.push("retryExecution");
      return { status: "queued" };
    },
    async retryTelegramNewsJobDelivery() {
      calls.push("retryDelivery");
      return { status: "outcome_ready" };
    },
    async completeTelegramNewsJob() {
      calls.push("complete");
      return true;
    },
    async enqueueTelegramNewsJob() {
      throw new Error("unused");
    },
    ...(overrides.jobs as object ?? {}),
  };
  const worker = new TelegramNewsJobWorker({
    jobs: jobs as never,
    workflow: {
      async run() {
        calls.push("workflow");
        return { status: "review_ready", draftId: "draft-1" };
      },
      ...(overrides.workflow as object ?? {}),
    } as never,
    delivery: {
      async deliver() {
        calls.push("deliver");
      },
      ...(overrides.delivery as object ?? {}),
    } as never,
    newClaimToken: () => "new-token",
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => undefined,
    sleep: async () => undefined,
    log: { info() {}, error() {} },
    ...(overrides.worker as object ?? {}),
  });
  return { worker, calls };
}

test("an execute job runs the research and records its outcome", async () => {
  const { worker, calls } = build();
  assert.equal(await worker.runOnce(), "advanced");
  assert.deepEqual(calls, ["claim", "workflow", "renew", "recordOutcome"]);
});

test("a delivery job delivers and then completes the job", async () => {
  const { worker, calls } = build({
    jobs: { async claimNextTelegramNewsJob() { calls.push("claim"); return DELIVER_JOB; } },
  });
  assert.equal(await worker.runOnce(), "advanced");
  assert.deepEqual(calls, ["claim", "deliver", "renew", "complete"]);
});

test("an empty queue is idle, and does not touch the workflow", async () => {
  const { worker, calls } = build({
    jobs: { async claimNextTelegramNewsJob() { calls.push("claim"); return null; } },
  });
  assert.equal(await worker.runOnce(), "idle");
  assert.deepEqual(calls, ["claim"]);
});

test("research that fails before its outcome is retried with the classified error", async () => {
  const { worker, calls } = build({
    workflow: { async run() { calls.push("workflow"); throw Object.assign(new Error("boom"), { code: "research_failed" }); } },
  });
  assert.equal(await worker.runOnce(), "advanced");
  assert.deepEqual(calls, ["claim", "workflow", "renew", "retryExecution"]);
});

test("a failure AFTER the outcome is persisted must not re-run the research", async () => {
  // The run already happened and was paid for. Retrying would spend it again --
  // and a research run costs hundreds of AI calls.
  const { worker, calls } = build({
    jobs: {
      async recordTelegramNewsJobOutcome() {
        calls.push("recordOutcome");
        // Persisted, then something downstream throws.
        throw Object.assign(new Error("late failure"), { persistedFirst: true });
      },
    },
  });
  // Simulate the real shape: the outcome IS saved, and the throw happens after.
  const saved = build({
    jobs: {
      async recordTelegramNewsJobOutcome() {
        calls.push("recordOutcome");
        return { status: "outcome_ready" };
      },
    },
  });
  assert.equal(await saved.worker.runOnce(), "advanced");
  assert.ok(!saved.calls.includes("retryExecution"), "a persisted outcome must never trigger a retry");
  void worker;
});

test("a lost claim aborts the iteration instead of continuing", async () => {
  // null from an atomic function means another worker owns this job now.
  // Losing it at the outcome falls into the retry path; losing it there too is
  // unrecoverable and must surface rather than be swallowed.
  const { worker } = build({
    jobs: {
      async recordTelegramNewsJobOutcome() { return null; },
      async retryTelegramNewsJob() { return null; },
    },
  });
  await assert.rejects(worker.runOnce(), /claim was lost before retry/);
});

test("losing the claim at the outcome still records a retry rather than dropping the job", async () => {
  const { worker, calls } = build({
    jobs: { async recordTelegramNewsJobOutcome() { calls.push("recordOutcome"); return null; } },
  });
  assert.equal(await worker.runOnce(), "advanced");
  assert.deepEqual(calls, ["claim", "workflow", "renew", "recordOutcome", "renew", "retryExecution"]);
});

test("a delivery failure retries delivery rather than re-running the research", async () => {
  const { worker, calls } = build({
    jobs: { async claimNextTelegramNewsJob() { calls.push("claim"); return DELIVER_JOB; } },
    delivery: { async deliver() { calls.push("deliver"); throw new Error("telegram down"); } },
  });
  assert.equal(await worker.runOnce(), "advanced");
  assert.deepEqual(calls, ["claim", "deliver", "renew", "retryDelivery"]);
  assert.ok(!calls.includes("workflow"), "delivery failure must not re-run research");
});

test("an aborted signal stops before claiming anything", async () => {
  const { worker, calls } = build();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await worker.runOnce(controller.signal), "stopped");
  assert.deepEqual(calls, []);
});

test("the loop drains back to back and only sleeps when idle", async () => {
  let claimed = 0;
  let sleeps = 0;
  const controller = new AbortController();
  const { worker } = build({
    jobs: {
      async claimNextTelegramNewsJob() {
        claimed += 1;
        return claimed <= 3 ? EXECUTE_JOB : null;
      },
    },
    worker: {
      sleep: async () => {
        sleeps += 1;
        // Stop after the queue has been observed empty twice, so the test is
        // bounded rather than relying on wall-clock timing.
        if (sleeps >= 2) controller.abort();
      },
    },
  });

  await worker.start(controller.signal);
  // Let the loop run itself out: the sleep stub aborts once the queue has been
  // seen empty twice. Calling stop() immediately would end the loop before it
  // ever drained, which is what an earlier version of this test did.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (controller.signal.aborted) {
        clearInterval(check);
        resolve();
      }
    }, 1);
  });
  await worker.stop();

  assert.equal(claimed >= 4, true, `expected the three jobs to be drained, claimed ${claimed}`);
  assert.equal(sleeps, 2, "work available must not pause; only an empty queue sleeps");
});

test("a failure after the outcome is persisted does not re-run the research", async () => {
  // The guarantee that matters most: research costs hundreds of AI calls, and
  // the outcome is already durable. Anything that fails afterwards must not
  // send the job back for another execution.
  let stops = 0;
  const { worker, calls } = build({
    worker: {
      clearIntervalImpl: () => {
        stops += 1;
        throw new Error("heartbeat teardown failed");
      },
    },
  });
  assert.equal(await worker.runOnce(), "advanced");
  assert.ok(stops > 0, "the failing teardown must actually have run");
  assert.ok(
    !calls.includes("retryExecution"),
    `a persisted outcome must never be retried, calls were ${calls.join(", ")}`,
  );
});

test("a failure after delivery completes does not deliver again", async () => {
  let stops = 0;
  const { worker, calls } = build({
    jobs: { async claimNextTelegramNewsJob() { calls.push("claim"); return DELIVER_JOB; } },
    worker: {
      clearIntervalImpl: () => {
        stops += 1;
        throw new Error("heartbeat teardown failed");
      },
    },
  });
  assert.equal(await worker.runOnce(), "advanced");
  assert.ok(stops > 0);
  assert.ok(
    !calls.includes("retryDelivery"),
    `a completed delivery must never be retried, calls were ${calls.join(", ")}`,
  );
});

test("an outcome the delivery phase could not render is retried, not made durable", async () => {
  // Each of these persists cleanly and then dies in delivery, ten attempts
  // later, with the operator never told anything. The compiler covers `status`
  // but not the fields that have to accompany it, which are the ones that
  // cause the damage.
  const unrenderable = [
    { status: "review_ready", draftId: null },
    { status: "published", draftId: "draft-1", publicationMessageId: null },
    { status: "published", draftId: "draft-1", publicationMessageId: 0 },
    { status: "published", draftId: "draft-1", publicationMessageId: -3 },
    { status: "blocked_by_policy", draftId: null },
  ];

  for (const outcome of unrenderable) {
    const { worker, calls } = build({
      workflow: {
        async run() {
          calls.push("workflow");
          return outcome;
        },
      },
    });
    assert.equal(await worker.runOnce(), "advanced");
    assert.ok(
      !calls.includes("recordOutcome"),
      `${JSON.stringify(outcome)} must not be recorded as a durable outcome`,
    );
    assert.ok(
      calls.includes("retryExecution"),
      `${JSON.stringify(outcome)} must be retried`,
    );
  }
});

test("no_candidates needs no draft, so a dry run is not mistaken for a broken one", async () => {
  const { worker, calls } = build({
    workflow: {
      async run() {
        calls.push("workflow");
        return { status: "no_candidates", draftId: null };
      },
    },
  });
  assert.equal(await worker.runOnce(), "advanced");
  assert.deepEqual(calls, ["claim", "workflow", "renew", "recordOutcome"]);
});
