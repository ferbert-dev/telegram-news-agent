import assert from "node:assert/strict";
import test from "node:test";
import {
  runNewsScheduler,
  runScheduledNewsOnce,
} from "../src/news-scheduler.js";
import { NoResearchCandidatesError } from "../src/research.js";
import { createFallbackAiProvider } from "../src/ai-provider.js";
import { publishScheduledDraft } from "../src/scheduled-publication.js";

const CLAIM = {
  telegram_channel_id: "@channel",
  review_chat_id: 55,
  schedule_interval_minutes: 360,
  language_code: "en",
  topic_codes: ["world"],
  custom_topics: [],
  approval_policy: "manual",
  quiet_hours_enabled: false,
  schedule_claim_token: "claim-1",
  schedule_run_id: "run-1",
  version: 3,
  updated_by: 7,
};

function fixture(overrides = {}) {
  const calls = [];
  const repository = {
    async claimDueNewsSchedule() {
      return CLAIM;
    },
    async hasPendingTelegramReview() {
      return false;
    },
    async finishNewsSchedule(input) {
      calls.push(["finish", input]);
      return true;
    },
    async saveNewsScheduleDraft(input) {
      calls.push(["saveDraft", input]);
      return true;
    },
    async saveNewsSchedulePublication(input) {
      calls.push(["savePublication", input]);
      return true;
    },
    async renewNewsScheduleClaim() {
      return true;
    },
    async deferNewsScheduleForQuietHours(input) {
      calls.push(["deferQuiet", input]);
      return true;
    },
    async pauseNewsScheduleUnresolved(input) {
      calls.push(["pause", input]);
      return true;
    },
    ...overrides.repository,
  };
  return {
    calls,
    dependencies: {
      repository,
      runNews: async () => ({
        result: {
          status: "awaiting_approval",
          draft: { id: "draft-1" },
          preview: "Preview",
        },
        tier: { windowHours: 48 },
      }),
      publishDraft: async ({ draftId }) => ({
        publication: { telegram_message_id: draftId === "draft-auto" ? 99 : 98 },
      }),
      deliverReviewDraft: async (input) => calls.push(["review", input]),
      notifyAdmin: async (...args) => calls.push(["notify", ...args]),
      log: { error() {}, info() {} },
      ...overrides.dependencies,
    },
  };
}

test("scheduler stays idle when no configuration is due", async () => {
  const { dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return null; } },
  });
  assert.deepEqual(await runScheduledNewsOnce(dependencies), { status: "idle" });
});

test("night pause defers a claimed occurrence before research starts", async () => {
  let researched = false;
  const claim = { ...CLAIM, quiet_hours_enabled: true };
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: { async runNews() { researched = true; } },
  });

  const result = await runScheduledNewsOnce({
    ...dependencies,
    now: () => new Date("2026-08-07T20:00:00.000Z"),
  });

  assert.equal(result.status, "quiet_hours_deferred");
  assert.equal(researched, false);
  assert.deepEqual(calls, [
    [
      "deferQuiet",
      { channelId: "@channel", claimToken: "claim-1" },
    ],
  ]);
});

test("night pause checkpoints completed research and defers publication", async () => {
  let published = false;
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    quiet_hours_enabled: true,
  };
  const times = [
    new Date("2026-08-07T19:59:00.000Z"),
    new Date("2026-08-07T20:00:00.000Z"),
  ];
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: { async publishDraft() { published = true; } },
  });

  const result = await runScheduledNewsOnce({
    ...dependencies,
    now: () => times.shift() ?? times.at(-1),
  });

  assert.equal(result.status, "quiet_hours_deferred");
  assert.equal(result.draftId, "draft-1");
  assert.equal(published, false);
  assert.equal(calls[0][0], "saveDraft");
  assert.equal(calls[1][0], "deferQuiet");
  assert.equal(calls.some(([name]) => name === "finish"), false);
});

test("night pause rechecks immediately before automatic publication", async () => {
  let published = false;
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    quiet_hours_enabled: true,
    schedule_draft_id: "draft-ready",
    schedule_preview: "Ready preview",
    schedule_window_hours: 48,
  };
  const times = [
    new Date("2026-08-07T19:59:00.000Z"),
    new Date("2026-08-07T19:59:30.000Z"),
    new Date("2026-08-07T20:00:00.000Z"),
  ];
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: { async publishDraft() { published = true; } },
  });

  const result = await runScheduledNewsOnce({
    ...dependencies,
    now: () => times.shift() ?? new Date("2026-08-07T20:00:00.000Z"),
  });

  assert.equal(result.status, "quiet_hours_deferred");
  assert.equal(result.draftId, "draft-ready");
  assert.equal(published, false);
  assert.equal(calls.some(([name]) => name === "deferQuiet"), true);
});

test("manual scheduled run creates one bound review and advances schedule", async () => {
  const { calls, dependencies } = fixture();
  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(calls[0][0], "saveDraft");
  assert.deepEqual(calls[1], [
    "review",
    {
      channelId: "@channel",
      chatId: 55,
      requestedBy: 7,
      draftId: "draft-1",
      preview: "Preview",
    },
  ]);
  assert.equal(calls[2][1].status, "awaiting_approval");
});

test("manual scheduler skips while another review is pending", async () => {
  let ran = false;
  const { calls, dependencies } = fixture({
    repository: { async hasPendingTelegramReview() { return true; } },
    dependencies: { async runNews() { ran = true; } },
  });
  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "skipped_pending_review");
  assert.equal(ran, false);
  assert.equal(calls[0][1].status, "skipped_pending_review");
});

test("automatic scheduled run reports an idempotently published message", async () => {
  const claim = { ...CLAIM, approval_policy: "automatic" };
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: {
      async runNews() {
        return {
          result: {
            status: "awaiting_approval",
            draft: { id: "draft-auto" },
            preview: "Preview auto",
          },
          tier: { windowHours: 48 },
        };
      },
    },
  });
  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "published");
  assert.equal(calls[0][0], "saveDraft");
  assert.equal(calls[1][0], "savePublication");
  assert.equal(calls[2][1].status, "published");
  assert.deepEqual(calls[3], [
    "notify",
    55,
    "Scheduled article published as Telegram message 99.",
  ]);
});

test("no candidates is a successful terminal schedule outcome", async () => {
  const { calls, dependencies } = fixture({
    dependencies: {
      async runNews() {
        throw new NoResearchCandidatesError("empty");
      },
    },
  });
  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "no_candidates");
  assert.equal(calls[0][1].status, "no_candidates");
});

test("terminal aggregate provider failure sends its generated trace in one private alert", async () => {
  const provider = createFallbackAiProvider([{ name: "openai", async generateStructured() {
    throw Object.assign(new Error("secret provider text"), { status: 401 });
  } }], { log: { warn() {} }, sleep: async () => {} });
  const { calls, dependencies } = fixture({ dependencies: {
    async runNews() { await provider.generateStructured({ usageOperation: "editorial_draft" }); },
  } });
  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "failed");
  const alerts = calls.filter(([name]) => name === "notify");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][2], /scheduled_run_failed.*trace: [0-9a-f-]{36}/i);
  assert.doesNotMatch(alerts[0][2], /secret|raw|editorial_draft|openai/i);
});

test("scheduled work starts only inside the injected audit boundary", async () => {
  let auditStarted = false;
  const { dependencies } = fixture({
    dependencies: {
      async withAudit(context, operation) {
        assert.equal(context.claim.schedule_run_id, "run-1");
        auditStarted = true;
        return operation();
      },
      async runNews() {
        assert.equal(auditStarted, true);
        throw new NoResearchCandidatesError("empty");
      },
    },
  });
  assert.equal((await runScheduledNewsOnce(dependencies)).status, "no_candidates");
});

test("stale schedule recovery resumes the checkpointed draft instead of researching again", async () => {
  let researched = false;
  let publishedDraft;
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    schedule_draft_id: "draft-recovered",
    schedule_preview: "Recovered preview",
    schedule_window_hours: 48,
  };
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: {
      async runNews() { researched = true; },
      async publishDraft({ draftId }) {
        publishedDraft = draftId;
        return { publication: { telegram_message_id: 77 } };
      },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "published");
  assert.equal(researched, false);
  assert.equal(publishedDraft, "draft-recovered");
  assert.equal(calls.some(([name]) => name === "saveDraft"), false);
  assert.equal(calls.find(([name]) => name === "finish")[1].status, "published");
});

test("an unresolved automatic send pauses recurrence", async () => {
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    schedule_draft_id: "draft-unresolved",
    schedule_preview: "Preview",
    schedule_window_hours: 48,
  };
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: {
      async publishDraft() { throw new Error("publication unresolved"); },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.errorCode, "publication_unresolved");
  assert.equal(calls.some(([name]) => name === "pause"), true);
  assert.equal(calls.some(([name]) => name === "finish"), false);
  assert.match(calls.find(([name]) => name === "notify")[2], /paused/i);
  assert.equal(calls.filter(([name]) => name === "notify").length, 1);
});

test("scheduler replaces an untrusted failure code with the safe fallback", async () => {
  const { calls, dependencies } = fixture({ dependencies: {
    async runNews() { const error = new Error("secret"); error.code = "<script>alert(1)</script>"; throw error; },
  } });
  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.errorCode, "scheduled_run_failed");
  assert.match(calls.find(([name]) => name === "notify")[2], /scheduled_run_failed/i);
  assert.doesNotMatch(calls.find(([name]) => name === "notify")[2], /script|secret/i);
});

test("a draft already being published is treated as unresolved", async () => {
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    schedule_draft_id: "draft-unresolved",
    schedule_preview: "Preview",
    schedule_window_hours: 48,
  };
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: {
      async publishDraft() { throw new Error("Draft is already being published"); },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.errorCode, "publication_unresolved");
  assert.equal(calls.some(([name]) => name === "pause"), true);
});

test("scheduler does not claim a pause or notify after losing ownership", async () => {
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    schedule_draft_id: "draft-unresolved",
    schedule_preview: "Preview",
    schedule_window_hours: 48,
  };
  const { calls, dependencies } = fixture({
    repository: {
      async claimDueNewsSchedule() { return claim; },
      async pauseNewsScheduleUnresolved(input) {
        calls.push(["pause", input]);
        return false;
      },
    },
    dependencies: {
      async publishDraft() { throw new Error("publication unresolved"); },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.errorCode, "claim_lost");
  assert.equal(calls.some(([name]) => name === "notify"), false);
});

test("manual recovery does not announce approval for a resolved review", async () => {
  const claim = {
    ...CLAIM,
    schedule_draft_id: "draft-resolved",
    schedule_preview: "Preview",
    schedule_window_hours: 48,
  };
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: {
      async deliverReviewDraft() {
        return { unavailable: true, decision: "reject" };
      },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "review_already_resolved");
  assert.equal(
    calls.find(([name]) => name === "finish")[1].status,
    "review_already_resolved",
  );
});

test("scheduler renews ownership before Telegram delivery", async () => {
  let delivered = false;
  const { dependencies } = fixture({
    repository: {
      async renewNewsScheduleClaim() {
        return false;
      },
    },
    dependencies: {
      async deliverReviewDraft() {
        delivered = true;
      },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.errorCode, "claim_lost");
  assert.equal(delivered, false);
});

test("failed review delivery retains the scheduled occurrence for recovery", async () => {
  const { calls, dependencies } = fixture({
    dependencies: {
      async deliverReviewDraft() {
        throw new Error("Telegram unavailable");
      },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.errorCode, "review_delivery_failed");
  assert.equal(calls.some(([name]) => name === "finish"), false);
  assert.equal(calls.some(([name]) => name === "pause"), false);
});

test("receipt failure does not rewrite a completed publication as failed", async () => {
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    schedule_draft_id: "draft-receipt",
    schedule_preview: "Preview",
    schedule_window_hours: 48,
    schedule_publication_message_id: 88,
  };
  const { calls, dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return claim; } },
    dependencies: {
      async notifyAdmin() { throw new Error("blocked"); },
      async publishDraft() { throw new Error("must not publish again"); },
    },
  });

  const result = await runScheduledNewsOnce(dependencies);
  assert.equal(result.status, "published");
  assert.equal(calls.find(([name]) => name === "finish")[1].status, "published");
});

test("scheduler recovery routes a durably rejected policy block through the common publisher and finishes terminally", async () => {
  const claim = {
    ...CLAIM,
    approval_policy: "automatic",
    schedule_draft_id: "draft-blocked",
    schedule_preview: "Blocked preview",
    schedule_window_hours: 48,
  };
  const { calls, dependencies } = fixture({
    repository: {
      async claimDueNewsSchedule() { return claim; },
      async getDraft() { return { id: "draft-blocked", status: "rejected" }; },
      async findPublicationByDraft() { return null; },
      async findPublicationPolicyBlockByDraft() {
        return { id: "block-1", reason_code: "excluded_topic_main_subject" };
      },
    },
  });
  const repository = dependencies.repository;
  dependencies.publishDraft = ({ draftId }) =>
    publishScheduledDraft({
      repository,
      aiProvider: null,
      token: "token",
      channelId: "@channel",
      draftId,
    });

  const result = await runScheduledNewsOnce(dependencies);

  assert.equal(result.status, "blocked_by_policy");
  assert.equal(
    calls.find(([name]) => name === "finish")[1].status,
    "blocked_by_policy",
  );
  assert.equal(calls.some(([name]) => name === "savePublication"), false);
});

test("scheduler contains a transient claim failure and continues to its backoff", async () => {
  const controller = new AbortController();
  let slept = false;
  const { dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { throw new Error("db down"); } },
  });
  await runNewsScheduler({
    ...dependencies,
    signal: controller.signal,
    sleepImpl: async () => {
      slept = true;
      controller.abort();
      throw controller.signal.reason;
    },
  });
  assert.equal(slept, true);
});

test("scheduler loop is abortable", async () => {
  const controller = new AbortController();
  let slept = false;
  const { dependencies } = fixture({
    repository: { async claimDueNewsSchedule() { return null; } },
  });
  await runNewsScheduler({
    ...dependencies,
    signal: controller.signal,
    sleepImpl: async () => {
      slept = true;
      controller.abort();
      throw controller.signal.reason;
    },
  });
  assert.equal(slept, true);
});
