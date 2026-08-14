import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverTelegramNewsJobOutcome,
  getTelegramNewsJobsConfig,
  runTelegramNewsJobOnce,
} from "../src/telegram-news-jobs.js";

const JOB = {
  id: "11111111-1111-4111-8111-111111111111",
  request_update_id: 101,
  telegram_channel_id: "@channel",
  control_chat_id: 9,
  requested_by: 5,
  settings_snapshot: {
    channelId: "@channel",
    reviewChatId: 9,
    updatedBy: 5,
    approvalPolicy: "manual",
    languageCode: "en",
    topicCodes: ["world"],
    customTopics: [],
    excludedTopicCodes: [],
    scheduleIntervalMinutes: null,
    quietHoursEnabled: true,
    version: 4,
  },
  claim_token: "22222222-2222-4222-8222-222222222222",
};

test("durable news jobs are explicitly disabled by default", () => {
  assert.deepEqual(getTelegramNewsJobsConfig({}), {
    enabled: false,
    pollIntervalMs: 2_000,
    staleAfterSeconds: 1_800,
    maxExecutionAttempts: 3,
    maxDeliveryAttempts: 10,
  });
  assert.equal(
    getTelegramNewsJobsConfig({ TELEGRAM_NEWS_JOB_MODE: "enabled" }).enabled,
    true,
  );
  assert.deepEqual(
    getTelegramNewsJobsConfig({
      TELEGRAM_NEWS_JOB_MODE: "off",
      TELEGRAM_NEWS_JOB_POLL_INTERVAL_MS: "not-an-integer",
      TELEGRAM_NEWS_JOB_STALE_AFTER_SECONDS: "0",
      TELEGRAM_NEWS_JOB_MAX_EXECUTION_ATTEMPTS: "999",
      TELEGRAM_NEWS_JOB_MAX_DELIVERY_ATTEMPTS: "999",
    }),
    getTelegramNewsJobsConfig({}),
  );
  assert.throws(
    () => getTelegramNewsJobsConfig({ TELEGRAM_NEWS_JOB_MODE: "yes" }),
    /must be off or enabled/,
  );
});

test("execution persists the checkpointed outcome before any admin delivery", async () => {
  const calls = [];
  const repository = {
    async claimNextTelegramNewsJob() {
      calls.push("claim");
      return { ...JOB, claim_phase: "execute" };
    },
    async renewTelegramNewsJobClaim() {
      calls.push("renew");
      return true;
    },
    async recordTelegramNewsJobOutcome(input) {
      calls.push(["outcome", input]);
      return {
        ...JOB,
        status: "outcome_ready",
        outcome_status: input.outcomeStatus,
      };
    },
  };

  const result = await runTelegramNewsJobOnce({
    repository,
    runNewsJob: async (job) => {
      calls.push(["run", job.request_update_id]);
      return {
        status: "review_ready",
        draftId: "33333333-3333-4333-8333-333333333333",
      };
    },
    deliverOutcome: async () => calls.push("deliver"),
    claimHeartbeatIntervalMs: 60_000,
  });

  assert.equal(result.status, "outcome_ready");
  assert.deepEqual(
    calls.map((entry) => (Array.isArray(entry) ? entry[0] : entry)),
    ["claim", "run", "renew", "outcome"],
  );
  assert.equal(calls.includes("deliver"), false);
  assert.deepEqual(calls.at(-1)[1], {
    jobId: JOB.id,
    claimToken: JOB.claim_token,
    outcomeStatus: "review_ready",
    draftId: "33333333-3333-4333-8333-333333333333",
    publicationMessageId: null,
    errorCode: null,
  });
});

test("delivery resumes from durable outcome without running research", async () => {
  const calls = [];
  const repository = {
    async claimNextTelegramNewsJob() {
      return {
        ...JOB,
        claim_phase: "deliver",
        outcome_status: "review_ready",
        draft_id: "33333333-3333-4333-8333-333333333333",
      };
    },
    async renewTelegramNewsJobClaim() {
      calls.push("renew");
      return true;
    },
    async completeTelegramNewsJob(input) {
      calls.push(["complete", input]);
      return true;
    },
  };

  const result = await runTelegramNewsJobOnce({
    repository,
    runNewsJob: async () => calls.push("run"),
    deliverOutcome: async (job) => calls.push(["deliver", job.outcome_status]),
    claimHeartbeatIntervalMs: 60_000,
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.includes("run"), false);
  assert.deepEqual(
    calls.map((entry) => (Array.isArray(entry) ? entry[0] : entry)),
    ["deliver", "renew", "complete"],
  );
});

test("review delivery restores the persisted review card with Publish/Reject controls", async () => {
  const calls = [];
  await deliverTelegramNewsJobOutcome({
    job: {
      ...JOB,
      outcome_status: "review_ready",
      draft_id: "33333333-3333-4333-8333-333333333333",
    },
    repository: {
      async getTelegramNewsCheckpoint(updateId) {
        calls.push(["checkpoint", updateId]);
        return {
          status: "review_ready",
          draft_id: "33333333-3333-4333-8333-333333333333",
          preview: "Selected article preview",
        };
      },
    },
    deliverReview: async (input) => {
      calls.push(["review", input]);
      return { sessionId: "session-1" };
    },
    sendAdmin: async (...args) => calls.push(["message", ...args]),
  });

  assert.deepEqual(calls, [
    ["checkpoint", 101],
    [
      "review",
      {
        channelId: "@channel",
        chatId: 9,
        requestedBy: 5,
        draftId: "33333333-3333-4333-8333-333333333333",
        preview: "Selected article preview",
      },
    ],
  ]);
});

test("review delivery fails closed when its durable checkpoint does not match", async () => {
  let delivered = false;
  await assert.rejects(
    deliverTelegramNewsJobOutcome({
      job: {
        ...JOB,
        outcome_status: "review_ready",
        draft_id: "33333333-3333-4333-8333-333333333333",
      },
      repository: {
        async getTelegramNewsCheckpoint() {
          return { status: "no_candidates", draft_id: null, preview: null };
        },
      },
      deliverReview: async () => {
        delivered = true;
      },
      sendAdmin: async () => {},
    }),
    /checkpoint is invalid/,
  );
  assert.equal(delivered, false);
});

test("a heartbeat failure after outcome persistence never retries execution", async () => {
  let retries = 0;
  const repository = {
    async claimNextTelegramNewsJob() {
      return { ...JOB, claim_phase: "execute" };
    },
    async renewTelegramNewsJobClaim() {
      return true;
    },
    async recordTelegramNewsJobOutcome(input) {
      return {
        ...JOB,
        status: "outcome_ready",
        outcome_status: input.outcomeStatus,
      };
    },
    async retryTelegramNewsJob() {
      retries += 1;
    },
  };
  let clearCalls = 0;

  const result = await runTelegramNewsJobOnce({
    repository,
    runNewsJob: async () => ({ status: "no_candidates" }),
    deliverOutcome: async () => {},
    claimHeartbeatIntervalMs: 60_000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {
      clearCalls += 1;
      throw new Error("heartbeat teardown failed");
    },
  });

  assert.equal(result.status, "outcome_ready");
  assert.equal(result.durable, true);
  assert.equal(retries, 0);
  assert.equal(clearCalls, 1);
});

test("a heartbeat failure after delivery completion never redelivers", async () => {
  let deliveryRetries = 0;
  const repository = {
    async claimNextTelegramNewsJob() {
      return {
        ...JOB,
        claim_phase: "deliver",
        outcome_status: "no_candidates",
      };
    },
    async renewTelegramNewsJobClaim() {
      return true;
    },
    async completeTelegramNewsJob() {
      return true;
    },
    async retryTelegramNewsJobDelivery() {
      deliveryRetries += 1;
    },
  };

  const result = await runTelegramNewsJobOnce({
    repository,
    runNewsJob: async () => {},
    deliverOutcome: async () => {},
    claimHeartbeatIntervalMs: 60_000,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {
      throw new Error("heartbeat teardown failed");
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.durable, true);
  assert.equal(deliveryRetries, 0);
});

test("retryable execution failures are token-fenced and sanitized", async () => {
  let retry;
  const repository = {
    async claimNextTelegramNewsJob() {
      return { ...JOB, claim_phase: "execute" };
    },
    async renewTelegramNewsJobClaim() {
      return true;
    },
    async retryTelegramNewsJob(input) {
      retry = input;
      return { status: "queued", execution_attempt_count: 1 };
    },
  };

  const result = await runTelegramNewsJobOnce({
    repository,
    runNewsJob: async () => {
      throw new Error("postgresql://secret.example/provider payload");
    },
    deliverOutcome: async () => {},
    classifyExecutionError: () => ({
      errorCode: "news_job_failed",
      terminal: false,
    }),
    maxExecutionAttempts: 3,
    claimHeartbeatIntervalMs: 60_000,
  });

  assert.equal(result.status, "queued");
  assert.deepEqual(retry, {
    jobId: JOB.id,
    claimToken: JOB.claim_token,
    errorCode: "news_job_failed",
    maxAttempts: 3,
    terminal: false,
  });
  assert.doesNotMatch(JSON.stringify(retry), /secret|provider payload/);
});

test("terminal execution failure is delivered as a sanitized durable admin outcome", async () => {
  const calls = [];
  let phase = "execute";
  let failureCode = null;
  const repository = {
    async claimNextTelegramNewsJob() {
      if (phase === "execute") {
        return { ...JOB, claim_phase: "execute" };
      }
      return {
        ...JOB,
        claim_phase: "deliver",
        outcome_status: "failed",
        error_code: failureCode,
      };
    },
    async renewTelegramNewsJobClaim() {
      return true;
    },
    async retryTelegramNewsJob(input) {
      phase = "deliver";
      failureCode = input.errorCode;
      return {
        ...JOB,
        status: "outcome_ready",
        outcome_status: "failed",
        error_code: input.errorCode,
      };
    },
    async completeTelegramNewsJob() {
      calls.push("complete");
      return true;
    },
  };
  let workflowRuns = 0;
  const dependencies = {
    repository,
    runNewsJob: async () => {
      workflowRuns += 1;
      throw new Error("postgresql://secret.example/provider payload");
    },
    deliverOutcome: (job) =>
      deliverTelegramNewsJobOutcome({
        job,
        repository,
        deliverReview: async () => {
          throw new Error("review delivery must not be used");
        },
        sendAdmin: async (...input) => calls.push(["admin", ...input]),
      }),
    classifyExecutionError: () => ({
      errorCode: "publication_unresolved",
      terminal: true,
    }),
    maxExecutionAttempts: 1,
    claimHeartbeatIntervalMs: 60_000,
  };

  assert.equal((await runTelegramNewsJobOnce(dependencies)).status, "outcome_ready");
  assert.equal((await runTelegramNewsJobOnce(dependencies)).status, "completed");
  assert.equal(workflowRuns, 1);
  assert.deepEqual(calls, [
    [
      "admin",
      JOB.control_chat_id,
      "The news request stopped because publication status is unresolved. Reconcile the draft before starting /news again.",
    ],
    "complete",
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /nothing was.*published/i);
  assert.doesNotMatch(JSON.stringify(calls), /secret|provider payload/);
});

test("generic terminal failure notice does not assert publication state", async () => {
  const messages = [];
  await deliverTelegramNewsJobOutcome({
    job: {
      ...JOB,
      outcome_status: "failed",
      error_code: "news_job_failed",
    },
    repository: {},
    deliverReview: async () => {},
    sendAdmin: async (...input) => messages.push(input),
  });
  assert.deepEqual(messages, [
    [
      JOB.control_chat_id,
      "The news request could not be completed after its retry budget. Check draft and publication status before starting /news again.",
    ],
  ]);
  assert.doesNotMatch(JSON.stringify(messages), /nothing was.*published/i);
});

test("retry persistence failures still stop the execution heartbeat", async () => {
  let clearCalls = 0;
  await assert.rejects(
    runTelegramNewsJobOnce({
      repository: {
        async claimNextTelegramNewsJob(input) {
          assert.equal(input.maxExecutionAttempts, 4);
          assert.equal(input.maxDeliveryAttempts, 11);
          return { ...JOB, claim_phase: "execute" };
        },
        async renewTelegramNewsJobClaim() {
          return true;
        },
        async retryTelegramNewsJob() {
          throw new Error("execution retry persistence failed");
        },
      },
      runNewsJob: async () => {
        throw new Error("execution failed");
      },
      deliverOutcome: async () => {},
      maxExecutionAttempts: 4,
      maxDeliveryAttempts: 11,
      claimHeartbeatIntervalMs: 60_000,
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {
        clearCalls += 1;
      },
    }),
    /execution retry persistence failed/,
  );
  assert.equal(clearCalls, 1);
});

test("admin delivery failures retry without rerunning the domain workflow", async () => {
  const calls = [];
  const repository = {
    async claimNextTelegramNewsJob() {
      return {
        ...JOB,
        claim_phase: "deliver",
        outcome_status: "no_candidates",
      };
    },
    async renewTelegramNewsJobClaim() {
      return true;
    },
    async retryTelegramNewsJobDelivery(input) {
      calls.push(["retryDelivery", input]);
      return { status: "outcome_ready", delivery_attempt_count: 1 };
    },
  };

  const result = await runTelegramNewsJobOnce({
    repository,
    runNewsJob: async () => calls.push("run"),
    deliverOutcome: async () => {
      calls.push("deliver");
      throw new Error("Telegram unavailable");
    },
    maxDeliveryAttempts: 10,
    claimHeartbeatIntervalMs: 60_000,
  });

  assert.equal(result.status, "outcome_ready");
  assert.equal(calls.includes("run"), false);
  assert.deepEqual(calls[1][1], {
    jobId: JOB.id,
    claimToken: JOB.claim_token,
    errorCode: "admin_delivery_failed",
    maxAttempts: 10,
  });
});

test("retry persistence failures still stop the delivery heartbeat", async () => {
  let clearCalls = 0;
  await assert.rejects(
    runTelegramNewsJobOnce({
      repository: {
        async claimNextTelegramNewsJob() {
          return {
            ...JOB,
            claim_phase: "deliver",
            outcome_status: "no_candidates",
          };
        },
        async renewTelegramNewsJobClaim() {
          return true;
        },
        async retryTelegramNewsJobDelivery() {
          throw new Error("delivery retry persistence failed");
        },
      },
      runNewsJob: async () => {},
      deliverOutcome: async () => {
        throw new Error("delivery failed");
      },
      claimHeartbeatIntervalMs: 60_000,
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {
        clearCalls += 1;
      },
    }),
    /delivery retry persistence failed/,
  );
  assert.equal(clearCalls, 1);
});

test("shutdown before claim accepts no new work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("shutdown"));
  let claimed = false;
  const result = await runTelegramNewsJobOnce({
    repository: {
      async claimNextTelegramNewsJob() {
        claimed = true;
      },
    },
    runNewsJob: async () => {},
    deliverOutcome: async () => {},
    signal: controller.signal,
  });
  assert.equal(result.status, "stopped");
  assert.equal(claimed, false);
});
