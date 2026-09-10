import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { Test } from "@nestjs/testing";

import { DRIZZLE_DB, PG_POOL } from "../../src/database/database.tokens.js";
import type {
  EditorialWorkflowApplicationPort,
  PublishApprovedDraftResult,
} from "../../src/editorial/editorial-application.contracts.js";
import type { EditorialPersistence } from "../../src/editorial/editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../../src/editorial/editorial-persistence.tokens.js";
import type { PipelineLeaseApplicationPort } from "../../src/operations/operations-application.contracts.js";
import { SchedulerService } from "../../src/scheduler/application/scheduler.service.js";
import { RunScheduledNewsOnceUseCase } from "../../src/scheduler/application/run-scheduled-news-once.use-case.js";
import type {
  SchedulerApplicationGateways,
} from "../../src/scheduler/scheduler-application.module.js";
import { SchedulerApplicationModule } from "../../src/scheduler/scheduler-application.module.js";
import type {
  SchedulerApplicationPort,
  SchedulerNewsWorkflowApplicationPort,
  SchedulerRunResult,
} from "../../src/scheduler/scheduler-application.contracts.js";
import { SCHEDULER_APPLICATION } from "../../src/scheduler/scheduler-application.tokens.js";
import type { SchedulerPersistence } from "../../src/scheduler/scheduler-persistence.contracts.js";
import { SCHEDULER_PERSISTENCE } from "../../src/scheduler/scheduler-persistence.tokens.js";
import type { NewsSettingsRow } from "../../src/settings/settings.contracts.js";
import type {
  TelegramReviewSessionsPersistence,
} from "../../src/telegram/telegram-persistence.contracts.js";
import { TELEGRAM_REVIEW_SESSIONS_PERSISTENCE } from "../../src/telegram/telegram-persistence.tokens.js";

const CLAIM: NewsSettingsRow = {
  telegram_channel_id: "@channel",
  review_chat_id: 55,
  schedule_interval_minutes: 180,
  language_code: "de",
  topic_codes: ["ai", "science"],
  custom_topics: ["Robotics"],
  excluded_topic_codes: ["war_conflict"],
  approval_policy: "manual",
  next_run_at: "2026-08-12T10:00:00.000Z",
  version: 7,
  updated_by: 9,
  schedule_claim_token: "schedule-token",
  schedule_claimed_at: "2026-08-12T10:00:00.000Z",
  schedule_run_id: "schedule-run",
  schedule_run_due_at: "2026-08-12T10:00:00.000Z",
  schedule_settings_snapshot: {
    channelId: "@channel",
    reviewChatId: 55,
    scheduleIntervalMinutes: 180,
    languageCode: "de",
    topicCodes: ["ai", "science"],
    customTopics: ["Robotics"],
    excludedTopicCodes: ["war_conflict"],
    excludedTopicsProvenance: {
      source: "news_bot_settings",
      settingsVersion: 7,
    },
    approvalPolicy: "manual",
    quietHoursEnabled: false,
    nextRunAt: "2026-08-12T10:00:00.000Z",
    version: 7,
    updatedBy: 9,
  },
  schedule_draft_id: null,
  schedule_preview: null,
  schedule_window_hours: null,
  schedule_publication_message_id: null,
  last_run_at: null,
  last_run_status: null,
  last_error_code: null,
  created_at: "2026-08-12T09:00:00.000Z",
  updated_at: "2026-08-12T10:00:00.000Z",
  quiet_hours_enabled: false,
};

type FixtureOverrides = {
  claim?: NewsSettingsRow | null;
  repository?: Partial<SchedulerPersistence>;
  reviews?: Partial<TelegramReviewSessionsPersistence>;
  editorialPersistence?: Partial<EditorialPersistence>;
  editorial?: Partial<EditorialWorkflowApplicationPort>;
  workflow?: Partial<SchedulerNewsWorkflowApplicationPort>;
  lease?: Partial<PipelineLeaseApplicationPort>;
  reviewDelivery?: SchedulerApplicationGateways["reviewDelivery"];
  audit?: SchedulerApplicationGateways["audit"];
  notify?: SchedulerApplicationGateways["notification"];
  times?: Date[];
};

function fixture(overrides: FixtureOverrides = {}) {
  const calls: unknown[][] = [];
  const timers = new Map<number, () => void | Promise<void>>();
  let timerId = 0;
  const claim = overrides.claim === undefined ? CLAIM : overrides.claim;

  const repository = {
    async claimDueNewsSchedule(input: unknown) {
      calls.push(["schedule:claim", input]);
      return claim;
    },
    async saveNewsScheduleDraft(input: unknown) {
      calls.push(["schedule:save-draft", input]);
      return true;
    },
    async saveNewsSchedulePublication(input: unknown) {
      calls.push(["schedule:save-publication", input]);
      return true;
    },
    async renewNewsScheduleClaim(input: unknown) {
      calls.push(["schedule:renew", input]);
      return true;
    },
    async deferNewsScheduleForQuietHours(input: unknown) {
      calls.push(["schedule:defer", input]);
      return true;
    },
    async pauseNewsScheduleUnresolved(input: unknown) {
      calls.push(["schedule:pause", input]);
      return true;
    },
    async finishNewsSchedule(input: unknown) {
      calls.push(["schedule:finish", input]);
      return true;
    },
    ...overrides.repository,
  } as SchedulerPersistence;
  const reviews = {
    async hasPendingTelegramReview(channelId: string) {
      calls.push(["review:pending", channelId]);
      return false;
    },
    ...overrides.reviews,
  } as TelegramReviewSessionsPersistence;
  const editorialPersistence = {
    async getDraft(id: string) {
      calls.push(["draft:get", id]);
      return {
        id,
        article_id: "article-1",
        body: "Grounded scheduled article",
        status: "review",
        model: "configured-model",
        prompt_version: "grounded-v2",
        reviewer_notes: null,
        approved_at: null,
        created_at: "2026-08-12T10:00:00.000Z",
        updated_at: "2026-08-12T10:00:00.000Z",
        articles: {
          id: "article-1",
          source_id: null,
          search_run_id: null,
          canonical_url: "https://example.test/article",
          title: "Article",
          author: null,
          published_at: null,
          discovered_at: "2026-08-12T10:00:00.000Z",
          content_hash: null,
          status: "drafted",
          metadata: {},
          created_at: "2026-08-12T10:00:00.000Z",
          updated_at: "2026-08-12T10:00:00.000Z",
        },
      };
    },
    async approveDraft(id: string) {
      calls.push(["draft:approve", id]);
      return undefined;
    },
    ...overrides.editorialPersistence,
  } as EditorialPersistence;
  const editorial = {
    async publishApprovedDraft(input: unknown): Promise<PublishApprovedDraftResult> {
      calls.push(["editorial:publish", input]);
      return {
        status: "published",
        publication: {
          id: "publication-1",
          draft_id: "draft-1",
          article_id: "article-1",
          telegram_channel_id: "@channel",
          telegram_message_id: 88,
          published_at: "2026-08-12T10:01:00.000Z",
          message_text: "Grounded scheduled article",
          metadata: {},
          created_at: "2026-08-12T10:01:00.000Z",
        },
        alreadyPublished: false,
      };
    },
    ...overrides.editorial,
  } as EditorialWorkflowApplicationPort;
  const workflow = {
    async run(input: unknown) {
      calls.push(["workflow:run", input]);
      return {
        status: "review_ready" as const,
        draftId: "draft-1",
        preview: "Grounded scheduled article",
        windowHours: 48,
      };
    },
    ...overrides.workflow,
  } as SchedulerNewsWorkflowApplicationPort;
  const lease = {
    async acquire(input: unknown) {
      calls.push(["lease:acquire", input]);
      return true;
    },
    async renew(input: unknown) {
      calls.push(["lease:renew", input]);
      return true;
    },
    async release(input: unknown) {
      calls.push(["lease:release", input]);
      return true;
    },
    ...overrides.lease,
  } as PipelineLeaseApplicationPort;
  const audit = overrides.audit ?? {
    async run(context, operation) {
      calls.push(["audit:start", context]);
      const result = await operation();
      calls.push(["audit:finish", result.status]);
      return result;
    },
  };
  const reviewDelivery = overrides.reviewDelivery ?? {
    async deliver(input) {
      calls.push(["review:deliver", input]);
      return { status: "review_ready" as const, resumed: false };
    },
  };
  const notification = overrides.notify ?? {
    async notify(input) {
      calls.push(["notify", input]);
    },
  };
  const times = [...(overrides.times ?? [new Date("2026-08-12T10:00:00.000Z")])];

  const useCase = new RunScheduledNewsOnceUseCase(
    repository,
    reviews,
    editorialPersistence,
    workflow,
    editorial,
    lease,
    reviewDelivery,
    audit,
    notification,
    { next: () => "generated-owner" },
    { now: () => times.shift() ?? new Date("2026-08-12T10:00:00.000Z") },
    {
      setInterval(callback: () => void | Promise<void>) {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
      clearInterval(id: unknown) {
        timers.delete(id as number);
      },
    },
  );

  return { calls, timers, useCase, repository };
}

test("one-shot scheduler stays idle without acquiring leases or entering audit when no row is due", async () => {
  const { calls, useCase } = fixture({ claim: null });
  assert.deepEqual(await useCase.execute({ claimToken: "claim" }), { status: "idle" });
  assert.deepEqual(calls, [["schedule:claim", { claimToken: "claim", staleAfterSeconds: 1800 }]]);
});

test("manual run preserves the claimed settings snapshot, lease fencing, checkpoint and required review delivery", async () => {
  const calls: unknown[][] = [];
  const { useCase, calls: internalCalls, timers } = fixture({
    workflow: {
      async run(input) {
        calls.push(["workflow", input]);
        return {
          status: "review_ready",
          draftId: "draft-manual",
          preview: "Manual preview",
          windowHours: 168,
        };
      },
    },
    reviewDelivery: {
      async deliver(input) {
        calls.push(["review", input]);
        return { status: "review_ready", resumed: false };
      },
    },
  });
  const result = await useCase.execute({
    claimToken: "schedule-token",
    leaseOwnerId: "pipeline-owner",
  });

  assert.equal(result.status, "awaiting_approval");
  assert.deepEqual(calls[0], [
    "workflow",
    {
      settingsSnapshot: {
        ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
        approvalPolicy: "manual",
      },
      lease: { name: "daily-news-pipeline", ownerId: "pipeline-owner" },
      signal: undefined,
    },
  ]);
  assert.deepEqual(calls[1], [
    "review",
    {
      channelId: "@channel",
      chatId: 55,
      requestedBy: 9,
      draftId: "draft-manual",
      preview: "Manual preview",
      signal: undefined,
    },
  ]);
  assert.equal(
    internalCalls.some(([name]) => name === "schedule:save-draft"),
    true,
  );
  assert.deepEqual(
    internalCalls
      .filter(([name]) => String(name).startsWith("lease:"))
      .map(([name]) => name),
    ["lease:acquire", "lease:release"],
  );
  assert.equal(timers.size, 0);
});

test("automatic run approves and publishes through EditorialWorkflow, persists receipt, and reports policy blocks terminally", async () => {
  const automatic = { ...CLAIM, approval_policy: "automatic" as const };
  automatic.schedule_settings_snapshot = {
    ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
    approvalPolicy: "automatic",
  };
  const published = fixture({ claim: automatic });
  const result = await published.useCase.execute({ claimToken: "schedule-token" });
  assert.equal(result.status, "published");
  assert.deepEqual(
    published.calls.find(([name]) => name === "editorial:publish")?.[1],
    {
      draftId: "draft-1",
      channelId: "@channel",
      publicationPath: "scheduler",
      signal: undefined,
    },
  );
  assert.equal(
    published.calls.some(([name]) => name === "schedule:save-publication"),
    true,
  );

  const blocked = fixture({
    claim: automatic,
    editorial: {
      async publishApprovedDraft() {
        return {
          status: "blocked",
          reasonCode: "excluded_topic_main_subject",
          publication: null,
          draft: {} as never,
        } as PublishApprovedDraftResult;
      },
    },
  });
  const blockedResult = await blocked.useCase.execute({ claimToken: "schedule-token" });
  assert.equal(blockedResult.status, "blocked_by_policy");
  assert.equal(
    blocked.calls.some(([name]) => name === "schedule:save-publication"),
    false,
  );
  assert.equal(
    (blocked.calls.find(([name]) => name === "schedule:finish")?.[1] as { status: string }).status,
    "blocked_by_policy",
  );
});

test("quiet hours defer before workflow and after a checkpoint across Europe/Madrid DST boundaries", async () => {
  for (const timestamp of [
    "2026-08-07T20:00:00.000Z",
    "2026-01-15T21:00:00.000Z",
  ]) {
    const quietClaim = { ...CLAIM, quiet_hours_enabled: true };
    quietClaim.schedule_settings_snapshot = {
      ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
      quietHoursEnabled: true,
    };
    const { calls, useCase } = fixture({
      claim: quietClaim,
      times: [new Date(timestamp)],
    });
    assert.equal((await useCase.execute({ claimToken: "schedule-token" })).status, "quiet_hours_deferred");
    assert.equal(calls.some(([name]) => name === "workflow:run"), false);
    assert.equal(calls.some(([name]) => name === "schedule:defer"), true);
  }

  const edgeClaim = { ...CLAIM, approval_policy: "automatic" as const, quiet_hours_enabled: true };
  edgeClaim.schedule_settings_snapshot = {
    ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
    approvalPolicy: "automatic",
    quietHoursEnabled: true,
  };
  const edge = fixture({
    claim: edgeClaim,
    times: [
      new Date("2026-08-07T19:59:00.000Z"),
      new Date("2026-08-07T20:00:00.000Z"),
    ],
  });
  const edgeResult = await edge.useCase.execute({ claimToken: "schedule-token" });
  assert.equal(edgeResult.status, "quiet_hours_deferred");
  assert.equal(edge.calls.some(([name]) => name === "schedule:save-draft"), true);
  assert.equal(edge.calls.some(([name]) => name === "editorial:publish"), false);
});

test("recovery resumes durable draft and publication checkpoints without rerunning workflow or resending", async () => {
  const recovered = fixture({
    claim: {
      ...CLAIM,
      approval_policy: "automatic",
      schedule_settings_snapshot: {
        ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
        approvalPolicy: "automatic",
      },
      schedule_draft_id: "draft-recovered",
      schedule_preview: "Recovered preview",
      schedule_window_hours: 168,
      schedule_publication_message_id: 99,
    },
  });
  const result = await recovered.useCase.execute({ claimToken: "schedule-token" });
  assert.equal(result.status, "published");
  assert.equal(result.publicationMessageId, 99);
  assert.equal(recovered.calls.some(([name]) => name === "workflow:run"), false);
  assert.equal(recovered.calls.some(([name]) => name === "editorial:publish"), false);
});

test("no candidates, pending review, lease busy/lost, stale owner and unresolved publication preserve legacy terminal identities", async () => {
  const noCandidates = fixture({
    workflow: { async run() { return { status: "no_candidates" }; } },
  });
  assert.equal((await noCandidates.useCase.execute()).status, "no_candidates");

  const pending = fixture({
    reviews: { async hasPendingTelegramReview() { return true; } },
  });
  assert.equal((await pending.useCase.execute()).status, "skipped_pending_review");
  assert.equal(pending.calls.some(([name]) => name === "workflow:run"), false);

  const busy = fixture({ lease: { async acquire() { return false; } } });
  const busyResult = await busy.useCase.execute();
  assert.equal(busyResult.status, "failed");
  assert.equal(busyResult.errorCode, "pipeline_busy");
  assert.equal(busyResult.settings?.version, 7);

  const stale = fixture({
    repository: { async renewNewsScheduleClaim() { return false; } },
  });
  assert.equal((await stale.useCase.execute()).errorCode, "claim_lost");

  const automatic = {
    ...CLAIM,
    approval_policy: "automatic" as const,
    schedule_settings_snapshot: {
      ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
      approvalPolicy: "automatic",
    },
    schedule_draft_id: "draft-unresolved",
    schedule_preview: "Preview",
    schedule_window_hours: 48,
  };
  const unresolved = fixture({
    claim: automatic,
    editorial: { async publishApprovedDraft() { throw new Error("publication unresolved"); } },
  });
  const unresolvedResult = await unresolved.useCase.execute();
  assert.equal(unresolvedResult.errorCode, "publication_unresolved");
  assert.equal(unresolved.calls.some(([name]) => name === "schedule:pause"), true);
  assert.equal(unresolved.calls.some(([name]) => name === "schedule:finish"), false);
});

test("AbortSignal is checked before claim and within the workflow while both heartbeats release cleanly", async () => {
  const before = fixture();
  const stopped = new AbortController();
  stopped.abort(new Error("shutdown-before-claim"));
  await assert.rejects(
    before.useCase.execute({ signal: stopped.signal }),
    /shutdown-before-claim/,
  );
  assert.deepEqual(before.calls, []);

  const within = new AbortController();
  const running = fixture({
    workflow: {
      async run(input) {
        within.abort(new Error("shutdown-during-workflow"));
        input.signal?.throwIfAborted();
        throw new Error("unreachable");
      },
    },
  });
  await assert.rejects(
    running.useCase.execute({ signal: within.signal }),
    /shutdown-during-workflow/,
  );
  assert.deepEqual(
    running.calls
      .filter(([name]) => String(name).startsWith("lease:"))
      .map(([name]) => name),
    ["lease:acquire", "lease:release"],
  );
  assert.equal(running.calls.some(([name]) => name === "schedule:finish"), false);
  assert.equal(running.timers.size, 0);
});

test("pipeline heartbeat fences a long workflow after lease ownership is lost and still releases the owner", async () => {
  let renewals = 0;
  let workflowStarted!: () => void;
  const started = new Promise<void>((resolve) => { workflowStarted = resolve; });
  let finishWorkflow!: () => void;
  const finish = new Promise<void>((resolve) => { finishWorkflow = resolve; });
  const lost = fixture({
    lease: {
      async renew() { renewals += 1; return false; },
    },
    workflow: {
      async run() {
        workflowStarted();
        await finish;
        return {
          status: "review_ready",
          draftId: "draft-lost",
          preview: "Lost owner preview",
          windowHours: 48,
        };
      },
    },
  });
  const outcome = lost.useCase.execute();
  await started;
  const heartbeatCallbacks = [...lost.timers.values()];
  assert.equal(heartbeatCallbacks.length, 2);
  heartbeatCallbacks[1]?.();
  await Promise.resolve();
  finishWorkflow();
  const result = await outcome;

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "claim_lost");
  assert.equal(renewals, 1);
  assert.deepEqual(
    lost.calls
      .filter(([name]) => String(name).startsWith("lease:"))
      .map(([name]) => name),
    ["lease:acquire", "lease:release"],
  );
  assert.equal(lost.calls.some(([name]) => name === "schedule:save-draft"), false);
  assert.equal(lost.timers.size, 0);
});

test("best-effort publication notification cannot rewrite success, while audit and review presentation remain required", async () => {
  const automatic = {
    ...CLAIM,
    approval_policy: "automatic" as const,
    schedule_settings_snapshot: {
      ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
      approvalPolicy: "automatic",
    },
  };
  const notifyFailure = fixture({
    claim: automatic,
    notify: { async notify() { throw new Error("notification unavailable"); } },
  });
  assert.equal((await notifyFailure.useCase.execute()).status, "published");

  const auditFailure = fixture({
    audit: { async run() { throw new Error("audit unavailable"); } },
  });
  const auditResult = await auditFailure.useCase.execute();
  assert.equal(auditResult.status, "failed");
  assert.equal(auditResult.errorCode, "scheduled_run_failed");
  assert.equal(auditResult.settings?.version, 7);

  const reviewFailure = fixture({
    reviewDelivery: {
      async deliver() { throw new Error("Telegram unavailable"); },
    },
  });
  const reviewResult = await reviewFailure.useCase.execute();
  assert.equal(reviewResult.errorCode, "review_delivery_failed");
  assert.equal(reviewFailure.calls.some(([name]) => name === "schedule:finish"), false);
});

test("schedule intervals remain exactly 1h/3h/6h/12h/24h and invalid snapshots fail closed", async () => {
  for (const interval of [60, 180, 360, 720, 1440]) {
    const row = {
      ...CLAIM,
      schedule_interval_minutes: interval,
      schedule_settings_snapshot: {
        ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
        scheduleIntervalMinutes: interval,
      },
    };
    const result = await fixture({ claim: row }).useCase.execute();
    assert.equal(result.settings?.scheduleIntervalMinutes, interval);
  }
  const invalid = fixture({
    claim: {
      ...CLAIM,
      schedule_settings_snapshot: {
        ...(CLAIM.schedule_settings_snapshot as Record<string, unknown>),
        scheduleIntervalMinutes: 30,
      },
    },
  });
  assert.equal((await invalid.useCase.execute()).errorCode, "scheduled_run_failed");
  assert.equal(invalid.calls.some(([name]) => name === "workflow:run"), false);
});

test("completed workflow results become durable before a post-result abort and retries never duplicate workflow work", async (t) => {
  await t.test("review_ready checkpoints before abort and retry presents the recovered draft", async () => {
    const controller = new AbortController();
    let claims = 0;
    let workflowRuns = 0;
    let deliveries = 0;
    const recoveredClaim = {
      ...CLAIM,
      schedule_claim_token: "recovery-token",
      schedule_draft_id: "draft-post-result-abort",
      schedule_preview: "Durable post-result preview",
      schedule_window_hours: 48,
    };
    const run = fixture({
      repository: {
        async claimDueNewsSchedule() {
          claims += 1;
          return claims === 1 ? CLAIM : recoveredClaim;
        },
      },
      workflow: {
        async run() {
          workflowRuns += 1;
          controller.abort(new Error("abort-after-review-result"));
          return {
            status: "review_ready",
            draftId: "draft-post-result-abort",
            preview: "Durable post-result preview",
            windowHours: 48,
          };
        },
      },
      reviewDelivery: {
        async deliver() {
          deliveries += 1;
          return { status: "review_ready" };
        },
      },
    });

    await assert.rejects(
      run.useCase.execute({ signal: controller.signal }),
      /abort-after-review-result/,
    );
    assert.equal(
      run.calls.filter(([name]) => name === "schedule:save-draft").length,
      1,
    );
    assert.equal(deliveries, 0);
    assert.deepEqual(
      run.calls
        .filter(([name]) => String(name).startsWith("lease:"))
        .map(([name]) => name),
      ["lease:acquire", "lease:release"],
    );
    assert.equal(run.timers.size, 0);

    const retry = await run.useCase.execute();
    assert.equal(retry.status, "awaiting_approval");
    assert.equal(workflowRuns, 1);
    assert.equal(deliveries, 1);
    assert.equal(run.timers.size, 0);
  });

  await t.test("no_candidates finishes before abort and retry is idle", async () => {
    const controller = new AbortController();
    let claims = 0;
    let workflowRuns = 0;
    const run = fixture({
      repository: {
        async claimDueNewsSchedule() {
          claims += 1;
          return claims === 1 ? CLAIM : null;
        },
      },
      workflow: {
        async run() {
          workflowRuns += 1;
          controller.abort(new Error("abort-after-empty-result"));
          return { status: "no_candidates" };
        },
      },
    });

    await assert.rejects(
      run.useCase.execute({ signal: controller.signal }),
      /abort-after-empty-result/,
    );
    assert.equal(
      run.calls.filter(
        ([name, input]) =>
          name === "schedule:finish" &&
          (input as { status: string }).status === "no_candidates",
      ).length,
      1,
    );
    assert.deepEqual(
      run.calls
        .filter(([name]) => String(name).startsWith("lease:"))
        .map(([name]) => name),
      ["lease:acquire", "lease:release"],
    );
    assert.equal(run.timers.size, 0);

    assert.deepEqual(await run.useCase.execute(), { status: "idle" });
    assert.equal(workflowRuns, 1);
  });
});

test("workflow and review ports reject malformed runtime discriminants without false checkpoint or success", async (t) => {
  const malformedWorkflowResults: unknown[] = [
    null,
    {},
    { status: "published" },
    { status: "review_ready", draftId: "", preview: "Preview", windowHours: 48 },
    { status: "review_ready", draftId: "draft", preview: "   ", windowHours: 48 },
    { status: "review_ready", draftId: 7, preview: "Preview", windowHours: 48 },
    { status: "review_ready", draftId: "draft", preview: "Preview", windowHours: 0 },
    { status: "review_ready", draftId: "draft", preview: "Preview", windowHours: "48" },
    { status: "review_ready", draftId: "draft", preview: "Preview", windowHours: 1.5 },
  ];
  for (const [index, malformed] of malformedWorkflowResults.entries()) {
    await t.test(`workflow case ${index + 1}`, async () => {
      const run = fixture({
        workflow: {
          async run() {
            return malformed as never;
          },
        },
      });
      const result = await run.useCase.execute();
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "scheduled_run_failed");
      assert.equal(
        run.calls.some(([name]) => name === "schedule:save-draft"),
        false,
      );
      assert.equal(
        run.calls.some(([name]) => name === "editorial:publish"),
        false,
      );
    });
  }

  for (const malformed of [
    null,
    {},
    { status: "published" },
    { status: "review_ready", resumed: "yes" },
    { status: "review_unavailable", decision: "hold" },
  ]) {
    await t.test(`review case ${JSON.stringify(malformed)}`, async () => {
      const run = fixture({
        claim: {
          ...CLAIM,
          schedule_draft_id: "draft-review-runtime",
          schedule_preview: "Review runtime preview",
          schedule_window_hours: 48,
        },
        reviewDelivery: {
          async deliver() {
            return malformed as never;
          },
        },
      });
      const result = await run.useCase.execute();
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "scheduled_run_failed");
      assert.equal(
        run.calls.some(
          ([name, input]) =>
            name === "schedule:finish" &&
            ["awaiting_approval", "review_already_resolved"].includes(
              (input as { status: string }).status,
            ),
        ),
        false,
      );
    });
  }
});

test("claimed settings snapshots are complete, internally consistent, and provenance-exact before any workflow side effect", async (t) => {
  const baseSnapshot = CLAIM.schedule_settings_snapshot as Record<string, unknown>;
  const cases: Array<{
    name: string;
    claim?: Partial<NewsSettingsRow>;
    mutate?: (snapshot: Record<string, unknown>) => void;
  }> = [
    {
      name: "missing language",
      mutate(snapshot) { delete snapshot.languageCode; },
    },
    {
      name: "wrong provenance source",
      mutate(snapshot) {
        snapshot.excludedTopicsProvenance = {
          source: "request",
          settingsVersion: 7,
        };
      },
    },
    {
      name: "wrong provenance version",
      mutate(snapshot) {
        snapshot.excludedTopicsProvenance = {
          source: "news_bot_settings",
          settingsVersion: 6,
        };
      },
    },
    {
      name: "extra provenance field",
      mutate(snapshot) {
        snapshot.excludedTopicsProvenance = {
          source: "news_bot_settings",
          settingsVersion: 7,
          inferred: true,
        };
      },
    },
    {
      name: "whitespace claimed channel",
      claim: { telegram_channel_id: "   " },
    },
    {
      name: "nonpositive review id",
      mutate(snapshot) { snapshot.reviewChatId = 0; },
    },
    {
      name: "nonpositive actor id",
      mutate(snapshot) { snapshot.updatedBy = -1; },
    },
    {
      name: "nonpositive claimed review id",
      claim: { review_chat_id: 0 },
    },
    {
      name: "nonpositive claimed settings version",
      claim: { version: 0 },
    },
    {
      name: "nonpositive claimed actor id",
      claim: { updated_by: 0 },
    },
    {
      name: "nonpositive publication checkpoint id",
      claim: { schedule_publication_message_id: 0 },
    },
    {
      name: "blank claim token",
      claim: { schedule_claim_token: " " },
    },
    {
      name: "blank run id",
      claim: { schedule_run_id: "" },
    },
    {
      name: "malformed topic array",
      mutate(snapshot) { snapshot.topicCodes = "ai"; },
    },
    {
      name: "malformed excluded array",
      mutate(snapshot) { snapshot.excludedTopicCodes = ["war_conflict", 7]; },
    },
    {
      name: "wrong interval type",
      mutate(snapshot) { snapshot.scheduleIntervalMinutes = "180"; },
    },
    {
      name: "unknown language status",
      mutate(snapshot) { snapshot.languageCode = "es"; },
    },
    {
      name: "unknown approval status",
      mutate(snapshot) { snapshot.approvalPolicy = "collect"; },
    },
    {
      name: "nonboolean quiet status",
      mutate(snapshot) { snapshot.quietHoursEnabled = "true"; },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const snapshot = structuredClone(baseSnapshot);
      entry.mutate?.(snapshot);
      const run = fixture({
        claim: {
          ...CLAIM,
          ...entry.claim,
          schedule_settings_snapshot: snapshot,
        },
      });
      const result = await run.useCase.execute();
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "scheduled_run_failed");
      assert.equal(
        run.calls.some(([name]) => name === "workflow:run"),
        false,
      );
      assert.equal(
        run.calls.some(([name]) => name === "review:deliver"),
        false,
      );
      assert.equal(
        run.calls.some(([name]) => name === "editorial:publish"),
        false,
      );
    });
  }
});

test("SchedulerApplicationModule compiles with real Nest identity and exports only its Symbol port", async () => {
  const gateways: SchedulerApplicationGateways = {
    newsWorkflow: { async run() { return { status: "no_candidates" }; } },
    editorial: {} as EditorialWorkflowApplicationPort,
    pipelineLease: {
      async acquire() { return true; },
      async renew() { return true; },
      async release() { return true; },
    },
    reviewDelivery: { async deliver() { return { status: "review_ready" }; } },
    audit: { async run(_context, operation) { return operation(); } },
    notification: { async notify() {} },
  };
  const module = SchedulerApplicationModule.register(gateways);
  assert.equal(module.module, SchedulerApplicationModule);
  assert.deepEqual(module.exports, [SCHEDULER_APPLICATION]);
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, SchedulerApplicationModule),
    undefined,
  );

  const fakePool = { on() {}, async query() { throw new Error("unused"); }, async end() {} };
  const moduleRef = await Test.createTestingModule({ imports: [module] })
    .overrideProvider(PG_POOL)
    .useValue(fakePool)
    .overrideProvider(DRIZZLE_DB)
    .useValue({
      async execute() { throw new Error("unused Drizzle execution"); },
      async transaction() { throw new Error("unused Drizzle transaction"); },
    })
    .overrideProvider(SCHEDULER_PERSISTENCE)
    .useValue(fixture().repository)
    .overrideProvider(TELEGRAM_REVIEW_SESSIONS_PERSISTENCE)
    .useValue({ async hasPendingTelegramReview() { return false; } })
    .overrideProvider(EDITORIAL_PERSISTENCE)
    .useValue({})
    .compile();
  const application = moduleRef.get<SchedulerApplicationPort>(SCHEDULER_APPLICATION);
  assert.ok(application instanceof SchedulerService);
  assert.equal(moduleRef.get(SchedulerService), application);
  await moduleRef.close();
});

test("a failed run names what failed without ever carrying the error's text", async () => {
  const leaky = Object.assign(
    new Error("provider said: invalid key sk-live-SECRET for chat 1009999777"),
    { name: "AiProvidersExhaustedError", code: "ai_providers_exhausted" },
  );
  const typed = await fixture({ audit: { async run() { throw leaky; } } }).useCase.execute();
  assert.equal(typed.status, "failed");
  assert.equal(typed.errorCode, "scheduled_run_failed", "the audit-facing code stays generic");
  assert.equal(typed.errorCause, "AiProvidersExhaustedError:ai_providers_exhausted");
  assert.doesNotMatch(JSON.stringify(typed), /SECRET|sk-live|1009999777|invalid key/u);

  const nested = new AggregateError(
    [
      Object.assign(new Error("timeout after 30000ms"), { code: "timeout" }),
      new TypeError("x.y is undefined"),
    ],
    "all providers failed",
  );
  const aggregate = await fixture({ audit: { async run() { throw nested; } } }).useCase.execute();
  assert.equal(aggregate.errorCause, "AggregateError,Error:timeout,TypeError");

  const driver = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
    code: "ECONNREFUSED",
  });
  const refused = await fixture({ audit: { async run() { throw driver; } } }).useCase.execute();
  assert.equal(refused.errorCause, "Error", "an upper-case driver code is not trusted into the log");
});
