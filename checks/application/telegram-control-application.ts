import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import type {
  TelegramControlAuditGateway,
  TelegramControlFeatureGateway,
  TelegramControlRequest,
  TelegramReviewPresentationGateway,
} from "../../src/telegram/telegram-application.contracts.js";
import { TelegramControlError } from "../../src/telegram/telegram-application.contracts.js";
import { HandleTelegramControlUpdateUseCase } from "../../src/telegram/application/handle-telegram-control-update.use-case.js";
import { GetTelegramStatsUseCase } from "../../src/telegram/application/get-telegram-stats.use-case.js";
import { HandleTelegramLabsUseCase } from "../../src/telegram/application/handle-telegram-labs.use-case.js";
import { HandleTelegramSettingsUseCase } from "../../src/telegram/application/handle-telegram-settings.use-case.js";
import { HandleTelegramStatusUseCase } from "../../src/telegram/application/handle-telegram-status.use-case.js";
import { RunTelegramNewsUseCase } from "../../src/telegram/application/run-telegram-news.use-case.js";
import { DecideTelegramReviewUseCase } from "../../src/telegram/application/decide-telegram-review.use-case.js";
import {
  TelegramBotApiGateway,
  TelegramBotApiOutcomeRenderer,
} from "../../src/telegram/transport/telegram-bot-api.gateway.js";
import { DeliverTelegramReviewUseCase } from "../../src/telegram/application/deliver-telegram-review.use-case.js";
import type {
  TelegramNewsJobsPersistence,
  TelegramReviewSessionsPersistence,
  TelegramUpdatesPersistence,
} from "../../src/telegram/telegram-persistence.contracts.js";
import type {
  EditorialWorkflowApplicationPort,
  PublishApprovedDraftInput,
} from "../../src/editorial/editorial-application.contracts.js";
import type {
  DraftRow,
  EditorialPersistence,
} from "../../src/editorial/editorial-persistence.contracts.js";
import type { SettingsService } from "../../src/settings/application/settings.service.js";

const BASE_REQUEST = {
  updateId: 101,
  updateKind: "news_command",
  channelId: "@channel",
  actorId: 9001,
  chatId: 7001,
  chatType: "private" as const,
};

const asNewsJobs = (
  overrides: Partial<TelegramNewsJobsPersistence>,
): TelegramNewsJobsPersistence => overrides as TelegramNewsJobsPersistence;

const DRAFT: DraftRow = {
  id: "draft-1",
  article_id: "article-1",
  body: "Grounded article",
  status: "review",
  model: "configured-model",
  prompt_version: "grounded-v2",
  reviewer_notes: null,
  approved_at: null,
  created_at: "2026-08-12T10:00:00.000Z",
  updated_at: "2026-08-12T10:00:00.000Z",
};

function asUpdates(value: object): TelegramUpdatesPersistence {
  return value as TelegramUpdatesPersistence;
}

function asReviews(value: object): TelegramReviewSessionsPersistence {
  return value as TelegramReviewSessionsPersistence;
}

function asEditorial(value: object): EditorialPersistence {
  return value as EditorialPersistence;
}

function asSettings(value: object): SettingsService {
  return value as SettingsService;
}

function asWorkflow(value: object): EditorialWorkflowApplicationPort {
  return value as EditorialWorkflowApplicationPort;
}

const allowAdmin = { async isChannelAdmin() { return true; } };
const passAudit: TelegramControlAuditGateway = {
  async run(_context, operation) { return operation(); },
};
const unusedFeature: TelegramControlFeatureGateway = {
  async execute() { throw new Error("unused feature gateway"); },
};

test("settings, labs, stats, and status routes have explicit transport-neutral use cases", async () => {
  const routed: string[] = [];
  const gateway: TelegramControlFeatureGateway = {
    async execute(request) {
      routed.push(request.route.kind);
      return { status: `${request.route.kind}_ready` };
    },
  };
  const settings = new HandleTelegramSettingsUseCase(gateway);
  const labs = new HandleTelegramLabsUseCase(gateway);
  const stats = new GetTelegramStatsUseCase(gateway);
  const status = new HandleTelegramStatusUseCase(gateway);

  assert.equal((await settings.execute({
    ...BASE_REQUEST,
    route: { kind: "settings", action: "open" },
  })).status, "settings_ready");
  assert.equal((await labs.execute({
    ...BASE_REQUEST,
    route: { kind: "labs", action: "open" },
  })).status, "labs_ready");
  assert.equal((await stats.execute({
    ...BASE_REQUEST,
    route: { kind: "stats" },
  })).status, "stats_ready");
  assert.equal((await status.execute({
    ...BASE_REQUEST,
    route: { kind: "status", action: "open" },
  })).status, "status_ready");
  assert.deepEqual(routed, ["settings", "labs", "stats", "status"]);

  assert.throws(
    () => settings.execute({ ...BASE_REQUEST, route: { kind: "stats" } }),
    (error) =>
      error instanceof TelegramControlError && error.code === "malformed_command",
  );
});

test("update routing is audited before atomic claim, finishes once, and duplicate/busy claims do not execute a handler", async () => {
  const calls: unknown[] = [];
  const updates = asUpdates({
    async claimTelegramUpdate(input: unknown) {
      calls.push(["claim", input]);
      return { claimed: true, claim_token: "token-1", claim_status: "claimed" };
    },
    async finishTelegramUpdate(input: unknown) {
      calls.push(["finish", input]);
      return true;
    },
  });
  const audit: TelegramControlAuditGateway = {
    async run(context, operation) {
      calls.push(["audit", context]);
      return operation();
    },
  };
  const settings: TelegramControlFeatureGateway = {
    async execute(request) {
      calls.push(["settings", request]);
      return { status: "settings_ready", view: { version: 7 } };
    },
  };
  const router = new HandleTelegramControlUpdateUseCase(
    updates,
    allowAdmin,
    audit,
    { async execute() { throw new Error("unused news"); } },
    { async execute() { throw new Error("unused review"); } },
    settings,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  const request: TelegramControlRequest = {
    ...BASE_REQUEST,
    updateKind: "settings_command",
    route: { kind: "settings", action: "open" },
  };

  const result = await router.execute(request, async (outcome) => {
    calls.push(["present", outcome]);
  });

  assert.equal(result.status, "settings_ready");
  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), [
    "audit",
    "claim",
    "settings",
    "present",
    "finish",
  ]);

  const terminalDuplicate = new HandleTelegramControlUpdateUseCase(
    asUpdates({
      async claimTelegramUpdate() {
        return { claimed: false, claim_token: null, claim_status: "terminal" };
      },
    }),
    allowAdmin,
    passAudit,
    { async execute() { throw new Error("must not execute"); } },
    { async execute() { throw new Error("must not execute"); } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  assert.deepEqual(await terminalDuplicate.execute(request, async () => {}), {
    status: "duplicate",
    updateId: request.updateId,
  });

  const busy = new HandleTelegramControlUpdateUseCase(
    asUpdates({
      async claimTelegramUpdate() {
        return { claimed: false, claim_token: null, claim_status: "busy" };
      },
    }),
    allowAdmin,
    passAudit,
    { async execute() { throw new Error("must not execute"); } },
    { async execute() { throw new Error("must not execute"); } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  await assert.rejects(
    busy.execute(request, async () => {}),
    (error) =>
      error instanceof TelegramControlError &&
      error.code === "update_in_progress",
  );
});

test("required presentation fails the claim for retry and checkpoint recovery avoids a duplicate domain mutation", async () => {
  const finishes: string[] = [];
  let domainMutations = 0;
  let rendered = 0;
  const completed = new Set<number>();
  const updates = asUpdates({
    async claimTelegramUpdate() {
      return { claimed: true, claim_token: "token-render", claim_status: "claimed" };
    },
    async finishTelegramUpdate(input: { status: string }) {
      finishes.push(input.status);
      return true;
    },
  });
  const news = {
    async execute(request: TelegramControlRequest) {
      if (!completed.has(request.updateId)) {
        domainMutations += 1;
        completed.add(request.updateId);
      }
      return { status: "no_candidates", updateId: request.updateId };
    },
  };
  const router = new HandleTelegramControlUpdateUseCase(
    updates,
    allowAdmin,
    passAudit,
    news,
    { async execute() { throw new Error("unused review"); } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  const request: TelegramControlRequest = {
    ...BASE_REQUEST,
    updateKind: "news_command",
    route: { kind: "news" },
  };

  await assert.rejects(
    router.execute(request, async (outcome) => {
      if (outcome.status === "no_candidates") throw new Error("Telegram send failed");
    }),
    /Telegram send failed/,
  );
  const recovered = await router.execute(request, async () => { rendered += 1; });

  assert.equal(recovered.status, "no_candidates");
  assert.equal(domainMutations, 1);
  assert.equal(rendered, 1);
  assert.deepEqual(finishes, ["failed", "completed"]);
});

test("invalid application envelopes reject before claim, while claimed malformed routes finish terminal without auth or domain mutation", async () => {
  const calls: string[] = [];
  const router = new HandleTelegramControlUpdateUseCase(
    asUpdates({
      async claimTelegramUpdate() {
        calls.push("claim");
        return { claimed: true, claim_token: "token-malformed", claim_status: "claimed" };
      },
      async finishTelegramUpdate(input: { status: string }) {
        calls.push(`finish:${input.status}`);
        return true;
      },
    }),
    { async isChannelAdmin() { calls.push("auth"); return true; } },
    passAudit,
    { async execute() { calls.push("domain"); return { status: "unexpected" }; } },
    { async execute() { calls.push("domain"); return { status: "unexpected" }; } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );

  await assert.rejects(
    router.execute({ ...BASE_REQUEST, updateId: 0, route: { kind: "stats" } }, async () => {}),
    (error) => error instanceof TelegramControlError && error.code === "malformed_update",
  );
  assert.deepEqual(calls, []);

  await assert.rejects(
    router.execute({ ...BASE_REQUEST, chatId: 0, route: { kind: "stats" } }, async () => {}),
    (error) => error instanceof TelegramControlError && error.code === "private_chat_required",
  );
  assert.deepEqual(calls, ["claim", "finish:completed"]);
  calls.length = 0;

  await assert.rejects(
    router.execute({
      ...BASE_REQUEST,
      updateKind: "labs_callback",
      route: {
        kind: "labs",
        action: "callback",
        payload: { callbackId: "", messageId: 12, action: { action: "view" } },
      },
    }, async () => {}),
    (error) => error instanceof TelegramControlError && error.code === "malformed_callback",
  );
  assert.deepEqual(calls, ["claim", "finish:completed"]);
  calls.length = 0;

  await assert.rejects(
    router.execute({
      ...BASE_REQUEST,
      updateKind: "news_callback",
      route: { kind: "malformed", target: "review", errorCode: "malformed_callback" },
    }, async () => {}),
    (error) => error instanceof TelegramControlError && error.code === "malformed_callback",
  );
  assert.deepEqual(calls, ["claim", "finish:completed"]);
});

test("terminal control failures finish completed while retryable failures finish failed with sanitized codes", async () => {
  const completions: unknown[] = [];
  const updates = asUpdates({
    async claimTelegramUpdate() {
      return { claimed: true, claim_token: "token-2", claim_status: "claimed" };
    },
    async finishTelegramUpdate(input: unknown) {
      completions.push(input);
      return true;
    },
  });
  const denied = new HandleTelegramControlUpdateUseCase(
    updates,
    { async isChannelAdmin() { return false; } },
    passAudit,
    { async execute() { throw new Error("unused"); } },
    { async execute() { throw new Error("unused"); } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  await assert.rejects(
    denied.execute({ ...BASE_REQUEST, route: { kind: "stats" } }, async () => {}),
    (error) => error instanceof TelegramControlError && error.code === "forbidden",
  );
  assert.deepEqual(completions[0], {
    updateId: BASE_REQUEST.updateId,
    claimToken: "token-2",
    status: "completed",
    errorCode: "forbidden",
  });

  completions.length = 0;
  const retryable = new HandleTelegramControlUpdateUseCase(
    updates,
    allowAdmin,
    passAudit,
    { async execute() { throw new Error("research unavailable"); } },
    { async execute() { throw new Error("unused"); } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  await assert.rejects(
    retryable.execute({ ...BASE_REQUEST, route: { kind: "news" } }, async () => {}),
    /research unavailable/,
  );
  assert.deepEqual(completions[0], {
    updateId: BASE_REQUEST.updateId,
    claimToken: "token-2",
    status: "failed",
    errorCode: "internal_error",
  });
});

test("automatic policy-block notice is retryable while manual review block remains best effort", async () => {
  const finishes: string[] = [];
  const notices: string[] = [];
  let domainMutations = 0;
  let checkpointed = false;
  let failAutomatic = true;
  const updates = asUpdates({
    async claimTelegramUpdate() {
      return { claimed: true, claim_token: "token-block", claim_status: "claimed" };
    },
    async finishTelegramUpdate(input: { status: string }) {
      finishes.push(input.status);
      return true;
    },
  });
  const renderer = new TelegramBotApiOutcomeRenderer(
    "token",
    async (_token, _method, payload) => {
      notices.push(String(payload.text));
      if (failAutomatic) {
        failAutomatic = false;
        throw new Error("automatic block notice failed");
      }
      return { message_id: 1 };
    },
  );
  const news = {
    async execute() {
      if (!checkpointed) {
        checkpointed = true;
        domainMutations += 1;
      }
      return {
        status: "blocked_by_policy",
        publicationPath: "automatic_news",
        resumed: domainMutations === 1 && notices.length > 0,
      };
    },
  };
  const router = new HandleTelegramControlUpdateUseCase(
    updates,
    allowAdmin,
    passAudit,
    news,
    {
      async execute() {
        return { status: "blocked_by_policy", publicationPath: "manual_review" };
      },
    },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  const newsRequest: TelegramControlRequest = {
    ...BASE_REQUEST,
    route: { kind: "news" },
  };
  const presentNews = (outcome: { status: string; [key: string]: unknown }) =>
    outcome.status === "research_started"
      ? Promise.resolve()
      : renderer.render(newsRequest, outcome);

  await assert.rejects(
    router.execute(newsRequest, presentNews),
    /automatic block notice failed/,
  );
  await router.execute(newsRequest, presentNews);
  assert.equal(domainMutations, 1);
  assert.equal(notices.length, 2);
  assert.deepEqual(finishes, ["failed", "completed"]);

  finishes.length = 0;
  const reviewRequest: TelegramControlRequest = {
    ...BASE_REQUEST,
    updateKind: "news_callback",
    route: {
      kind: "review",
      action: "publish",
      sessionId: "a".repeat(48),
      messageId: 55,
      callbackId: "cb-manual",
    },
  };
  const manualRenderer = new TelegramBotApiOutcomeRenderer(
    "token",
    async () => { throw new Error("manual block notice failed"); },
  );
  await router.execute(
    reviewRequest,
    (outcome) => manualRenderer.render(reviewRequest, outcome),
  );
  assert.deepEqual(finishes, ["completed"]);
});

test("Nest /news durably enqueues before presentation and suppresses a concurrent request", async () => {
  const calls: unknown[] = [];
  const settingsRow = {
    telegram_channel_id: "@channel",
    review_chat_id: BASE_REQUEST.chatId,
    schedule_interval_minutes: null,
    language_code: "en" as const,
    topic_codes: ["ai"],
    custom_topics: [],
    excluded_topic_codes: ["war_conflict"],
    approval_policy: "automatic" as const,
    next_run_at: null,
    version: 7,
    updated_by: BASE_REQUEST.actorId,
    schedule_claim_token: null,
    schedule_claimed_at: null,
    schedule_run_id: null,
    schedule_run_due_at: null,
    schedule_settings_snapshot: null,
    schedule_draft_id: null,
    schedule_preview: null,
    schedule_window_hours: null,
    schedule_publication_message_id: null,
    last_run_at: null,
    last_run_status: null,
    last_error_code: null,
    created_at: "2026-08-12T10:00:00.000Z",
    updated_at: "2026-08-12T10:00:00.000Z",
    quiet_hours_enabled: true,
  };
  const useCase = new RunTelegramNewsUseCase(
    asNewsJobs({
      async enqueueTelegramNewsJob(input: unknown) {
        calls.push(["enqueue", input]);
        return {
          id: "job-1",
          enqueue_outcome: "queued" as const,
          job_status: "queued" as const,
          active_job_id: null,
        };
      },
    }),
    asSettings({
      async getOrCreateNewsSettings(input: unknown) {
        calls.push(["settings", input]);
        return settingsRow;
      },
    }),
  );

  assert.deepEqual(
    await useCase.execute(
      { ...BASE_REQUEST, route: { kind: "news" } },
      "update-claim-token",
    ),
    {
      status: "research_queued",
      jobId: "job-1",
      enqueueOutcome: "queued",
    },
  );
  assert.deepEqual(calls, [
    [
      "settings",
      {
        channelId: "@channel",
        reviewChatId: BASE_REQUEST.chatId,
        updatedBy: BASE_REQUEST.actorId,
      },
    ],
    [
      "enqueue",
      {
        updateId: BASE_REQUEST.updateId,
        updateClaimToken: "update-claim-token",
        channelId: "@channel",
        controlChatId: BASE_REQUEST.chatId,
        requestedBy: BASE_REQUEST.actorId,
        settingsSnapshot: {
          channelId: "@channel",
          reviewChatId: BASE_REQUEST.chatId,
          scheduleIntervalMinutes: null,
          languageCode: "en",
          topicCodes: ["ai"],
          customTopics: [],
          excludedTopicCodes: ["war_conflict"],
          excludedTopicsProvenance: {
            source: "news_bot_settings",
            settingsVersion: 7,
          },
          approvalPolicy: "automatic",
          quietHoursEnabled: true,
          nextRunAt: null,
          version: 7,
          updatedBy: BASE_REQUEST.actorId,
        },
      },
    ],
  ]);

  const alreadyRunning = new RunTelegramNewsUseCase(
    asNewsJobs({
      async enqueueTelegramNewsJob() {
        return {
          id: "suppressed-job",
          enqueue_outcome: "already_running" as const,
          job_status: "suppressed" as const,
          active_job_id: "active-job",
        };
      },
    }),
    asSettings({
      async getOrCreateNewsSettings() {
        return settingsRow;
      },
    }),
  );
  assert.deepEqual(
    await alreadyRunning.execute(
      { ...BASE_REQUEST, updateId: 102, route: { kind: "news" } },
      "second-update-claim",
    ),
    {
      status: "already_running",
      jobId: "suppressed-job",
      activeJobId: "active-job",
      enqueueOutcome: "already_running",
    },
  );

  const ordered: unknown[] = [];
  const router = new HandleTelegramControlUpdateUseCase(
    asUpdates({
      async claimTelegramUpdate() {
        ordered.push("claim");
        return {
          claimed: true,
          claim_token: "router-update-claim",
          claim_status: "claimed",
        };
      },
      async finishTelegramUpdate() {
        ordered.push("finish");
        return true;
      },
    }),
    allowAdmin,
    passAudit,
    {
      async execute(_request, updateClaimToken) {
        ordered.push(["enqueue", updateClaimToken]);
        return { status: "research_queued" };
      },
    },
    { async execute() { throw new Error("unused review"); } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );
  await router.execute(
    { ...BASE_REQUEST, route: { kind: "news" } },
    async (outcome) => {
      ordered.push(["present", outcome.status]);
    },
  );
  assert.deepEqual(ordered, [
    "claim",
    ["enqueue", "router-update-claim"],
    ["present", "research_queued"],
    "finish",
  ]);
});

test("manual review decision disables winning controls before reject/publish and preserves double-tap recovery", async () => {
  let publishCalls = 0;
  const presentationCalls: string[] = [];
  const reviews = asReviews({
    async decideTelegramReviewSession(input: { action: string }) {
      return {
        session_id: "s".repeat(48),
        draft_id: DRAFT.id,
        decision: input.action,
        decision_won: input.action === "publish",
        expires_at: "2026-08-13T10:00:00.000Z",
      };
    },
  });
  const editorial = asWorkflow({
    async publishApprovedDraft() {
      publishCalls += 1;
      return {
        status: "already_blocked",
        reasonCode: "excluded_topic",
        publication: null,
        draft: { ...DRAFT, status: "rejected" },
      };
    },
  });
  const presentation: TelegramReviewPresentationGateway = {
    async restoreControls() { throw new Error("unused"); },
    async disableControls() { presentationCalls.push("disable"); },
    async answerCallback(input) { presentationCalls.push(`answer:${input.text}`); },
    async sendReview() { throw new Error("unused"); },
  };
  const useCase = new DecideTelegramReviewUseCase(reviews, editorial, presentation);

  const loser = await useCase.execute({
    ...BASE_REQUEST,
    updateKind: "news_callback",
    route: {
      kind: "review",
      action: "reject",
      sessionId: "s".repeat(48),
      messageId: 55,
      callbackId: "callback-1",
    },
  });
  assert.equal(loser.status, "already_decided");
  assert.equal(publishCalls, 0);
  assert.deepEqual(presentationCalls, ["answer:This draft was already rejected."]);

  const winner = await useCase.execute({
    ...BASE_REQUEST,
    updateKind: "news_callback",
    route: {
      kind: "review",
      action: "publish",
      sessionId: "s".repeat(48),
      messageId: 55,
      callbackId: "callback-2",
    },
  });
  assert.equal(winner.status, "blocked_by_policy");
  assert.equal(publishCalls, 1);
  assert.deepEqual(presentationCalls.slice(1), ["disable", "answer:Publishing..."]);

  const stale = new DecideTelegramReviewUseCase(
    asReviews({
      async decideTelegramReviewSession() {
        throw new Error("review session binding mismatch");
      },
    }),
    editorial,
    presentation,
  );
  await assert.rejects(
    stale.execute({
      ...BASE_REQUEST,
      route: {
        kind: "review",
        action: "publish",
        sessionId: "s".repeat(48),
        messageId: 54,
        callbackId: "callback-3",
      },
    }),
    (error) =>
      error instanceof TelegramControlError &&
      error.code === "invalid_review_session",
  );
});

test("winning review controls stay disabled across reject, definitive publish failure, and unresolved publication", async () => {
  const calls: string[] = [];
  const presentation: TelegramReviewPresentationGateway = {
    async restoreControls() { throw new Error("unused"); },
    async disableControls() { calls.push("disable"); },
    async answerCallback(input) { calls.push(`answer:${input.text}`); },
    async sendReview() { throw new Error("unused"); },
  };
  const decision = (action: "publish" | "reject") => asReviews({
    async decideTelegramReviewSession() {
      calls.push("decision");
      return {
        session_id: "s".repeat(48),
        draft_id: DRAFT.id,
        decision: action,
        decision_won: true,
        expires_at: "2026-08-13T10:00:00.000Z",
      };
    },
  });
  const request = (action: "publish" | "reject"): TelegramControlRequest => ({
    ...BASE_REQUEST,
    updateKind: "news_callback",
    route: {
      kind: "review",
      action,
      sessionId: "s".repeat(48),
      messageId: 55,
      callbackId: "callback-x",
    },
  });

  const rejected = await new DecideTelegramReviewUseCase(
    decision("reject"),
    asWorkflow({}),
    presentation,
  ).execute(request("reject"));
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(calls, ["decision", "disable", "answer:Draft rejected. Nothing was published."]);

  for (const [message, code] of [
    ["definitive provider failure", null],
    ["publication unresolved", "publication_unresolved"],
  ] as const) {
    calls.length = 0;
    const useCase = new DecideTelegramReviewUseCase(
      decision("publish"),
      asWorkflow({ async publishApprovedDraft() { calls.push("publish"); throw new Error(message); } }),
      presentation,
    );
    await assert.rejects(
      useCase.execute(request("publish")),
      code
        ? (error) => error instanceof TelegramControlError && error.code === code
        : (error) => error instanceof Error && error.message === message,
    );
    assert.deepEqual(calls, ["decision", "disable", "answer:Publishing...", "publish"]);
  }

  calls.length = 0;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const unresolved = new DecideTelegramReviewUseCase(
    decision("publish"),
    asWorkflow({
      async publishApprovedDraft(input: PublishApprovedDraftInput) {
        calls.push("publish");
        receivedSignal = input.signal;
        controller.abort("telegram-send-started");
        throw new Error(
          "Publication outcome is unresolved; draft remains in publishing state for manual reconciliation",
        );
      },
    }),
    presentation,
  );
  await assert.rejects(
    unresolved.execute(request("publish"), controller.signal),
    (error) => error instanceof TelegramControlError && error.code === "publication_unresolved",
  );
  assert.strictEqual(receivedSignal, controller.signal);
  assert.deepEqual(calls, ["decision", "disable", "answer:Publishing...", "publish"]);
});

test("admin authorization cancellation is forwarded to Telegram and remains claim-lost", async () => {
  const controller = new AbortController();
  const finishes: unknown[] = [];
  const authorization = new TelegramBotApiGateway(
    "token",
    "@channel",
    async (_token, method, _payload, options) => {
      assert.equal(method, "getChatMember");
      assert.strictEqual(options?.signal, controller.signal);
      controller.abort("lease-lost");
      throw new Error("Telegram request aborted");
    },
  );
  const router = new HandleTelegramControlUpdateUseCase(
    asUpdates({
      async claimTelegramUpdate() {
        return { claimed: true, claim_token: "token-admin-abort", claim_status: "claimed" };
      },
      async finishTelegramUpdate(input: unknown) { finishes.push(input); return true; },
    }),
    authorization,
    passAudit,
    { async execute() { throw new Error("domain must not run"); } },
    { async execute() { throw new Error("review must not run"); } },
    unusedFeature,
    unusedFeature,
    unusedFeature,
    unusedFeature,
  );

  await assert.rejects(
    router.execute({ ...BASE_REQUEST, route: { kind: "stats" } }, async () => {}, controller.signal),
    (error) => error instanceof TelegramControlError && error.code === "update_claim_lost",
  );
  assert.deepEqual(finishes, [{
    updateId: BASE_REQUEST.updateId,
    claimToken: "token-admin-abort",
    status: "failed",
    errorCode: "update_claim_lost",
  }]);
});

test("already-decided review answers receive cancellation and do not report success after loss", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const useCase = new DecideTelegramReviewUseCase(
    asReviews({
      async decideTelegramReviewSession() {
        return {
          session_id: "s".repeat(48), draft_id: DRAFT.id, decision: "reject",
          decision_won: false, expires_at: "2026-08-13T10:00:00.000Z",
        };
      },
    }),
    asWorkflow({}),
    {
      async restoreControls() { throw new Error("unused"); },
      async disableControls() { throw new Error("unused"); },
      async sendReview() { throw new Error("unused"); },
      async answerCallback(input) {
        receivedSignal = input.signal;
        controller.abort("lease-lost");
        input.signal?.throwIfAborted();
      },
    },
  );
  await assert.rejects(useCase.execute({
    ...BASE_REQUEST,
    route: {
      kind: "review", action: "reject", sessionId: "s".repeat(48),
      messageId: 55, callbackId: "callback-already-decided",
    },
  }, controller.signal));
  assert.strictEqual(receivedSignal, controller.signal);
});

test("review delivery never replaces or cleans up controls after cancellation", async () => {
  const controller = new AbortController();
  const sentMethods: string[] = [];
  const gateway = new TelegramBotApiGateway(
    "token",
    "@channel",
    async (_token, method, _payload, options) => {
      sentMethods.push(method);
      assert.strictEqual(options?.signal, controller.signal);
      controller.abort("lease-lost");
      throw new Error("Telegram request aborted");
    },
  );
  const existing = {
    id: "a".repeat(48), draft_id: DRAFT.id, telegram_channel_id: "@channel",
    control_chat_id: BASE_REQUEST.chatId, preview_message_id: 55, requested_by: BASE_REQUEST.actorId,
    decision: null, decided_by: null, decided_at: null,
    expires_at: "2026-08-13T10:00:00.000Z", created_at: "2026-08-12T09:00:00.000Z",
  };
  const delivery = new DeliverTelegramReviewUseCase(
    asReviews({ async findTelegramReviewSessionByDraft() { return existing; } }),
    asEditorial({ async getDraft() { return DRAFT; } }),
    gateway,
    { next: () => "b".repeat(48) },
    { now: () => new Date("2026-08-12T10:00:00.000Z") },
  );

  await assert.rejects(
    delivery.execute({
      draftId: DRAFT.id, channelId: "@channel", chatId: BASE_REQUEST.chatId,
      actorId: BASE_REQUEST.actorId, preview: DRAFT.body, signal: controller.signal,
    }),
    /Telegram request aborted/,
  );
  assert.deepEqual(sentMethods, ["editMessageReplyMarkup"]);

  const cleanupController = new AbortController();
  const cleanupMethods: string[] = [];
  const cleanupGateway = new TelegramBotApiGateway(
    "token",
    "@channel",
    async (_token, method, _payload, options) => {
      cleanupMethods.push(method);
      assert.strictEqual(options?.signal, cleanupController.signal);
      return {};
    },
  );
  const expired = { ...existing, expires_at: "2026-08-12T09:00:00.000Z" };
  const cleanup = new DeliverTelegramReviewUseCase(
    asReviews({
      async findTelegramReviewSessionByDraft() { return expired; },
      async renewTelegramReviewSession() {
        cleanupController.abort("lease-lost");
        return expired;
      },
    }),
    asEditorial({ async getDraft() { return DRAFT; } }),
    cleanupGateway,
    { next: () => "b".repeat(48) },
    { now: () => new Date("2026-08-12T10:00:00.000Z") },
  );
  const cleaned = await cleanup.execute({
    draftId: DRAFT.id, channelId: "@channel", chatId: BASE_REQUEST.chatId,
    actorId: BASE_REQUEST.actorId, preview: DRAFT.body, signal: cleanupController.signal,
  });
  assert.equal(cleaned.status, "review_unavailable");
  assert.deepEqual(cleanupMethods, ["editMessageReplyMarkup"]);
});

/**
 * Every route kind, each with a payload that passes validateRequest.
 *
 * validateRequest runs before requireAdmin, so a malformed payload is refused
 * as malformed_callback and proves nothing about authorization. Shared by both
 * authorization tests so neither can drift into testing validation instead.
 */
const EVERY_ROUTE: Array<Record<string, unknown>> = [
  { kind: "news" },
  {
    kind: "review",
    action: "publish",
    sessionId: "a".repeat(48),
    messageId: 55,
    callbackId: "cb-authz",
  },
  { kind: "settings" },
  { kind: "labs" },
  { kind: "stats" },
  { kind: "status" },
];

test("every route requires an administrator, not just the one route a test happened to pick", async () => {
  // The existing coverage denied a non-admin on `stats` alone. Moving
  // requireAdmin behind a condition, or adding a route that skips it, passed
  // all 358 application tests -- verified by mutation. `review` publishes to
  // the channel and `settings` changes what the bot is allowed to publish, so
  // those were the two the gap actually mattered for.
  //
  // Driven from the route list rather than a hand-written set, so a route added
  // later is covered the day it is added rather than the day someone remembers
  // to extend this.
  for (const route of EVERY_ROUTE) {
    const completions: Array<Record<string, unknown>> = [];
    let featureReached = false;
    const reject = {
      async execute() {
        featureReached = true;
        throw new Error("a denied actor must never reach a feature");
      },
    };
    const denied = new HandleTelegramControlUpdateUseCase(
      asUpdates({
        async claimTelegramUpdate() {
          return { claimed: true, claim_token: "token-x", claim_status: "claimed" };
        },
        async finishTelegramUpdate(input: unknown) {
          completions.push(input as Record<string, unknown>);
          return true;
        },
      }),
      { async isChannelAdmin() { return false; } },
      passAudit,
      reject as never,
      reject as never,
      reject as never,
      reject as never,
      reject as never,
      reject as never,
    );

    await assert.rejects(
      denied.execute({ ...BASE_REQUEST, route } as never, async () => {}),
      (error) =>
        error instanceof TelegramControlError && error.code === "forbidden",
      `route "${route.kind}" must refuse a non-administrator`,
    );
    assert.equal(
      featureReached,
      false,
      `route "${route.kind}" reached its feature despite the actor being denied`,
    );
    assert.equal(completions[0]?.errorCode, "forbidden");
  }
});

test("an authorization failure denies every route rather than falling open", async () => {
  // Fail-closed. If isChannelAdmin throws -- Telegram unreachable, a revoked
  // token -- no route may proceed. The distinction from `forbidden` matters
  // because this one is retryable and that one is not.
  for (const route of EVERY_ROUTE) {
    const kind = String(route.kind);
    let featureReached = false;
    const reject = {
      async execute() {
        featureReached = true;
        throw new Error("an unauthorized actor must never reach a feature");
      },
    };
    const unavailable = new HandleTelegramControlUpdateUseCase(
      asUpdates({
        async claimTelegramUpdate() {
          return { claimed: true, claim_token: "token-y", claim_status: "claimed" };
        },
        async finishTelegramUpdate() { return true; },
      }),
      { async isChannelAdmin() { throw new Error("telegram unreachable"); } },
      passAudit,
      reject as never,
      reject as never,
      reject as never,
      reject as never,
      reject as never,
      reject as never,
    );

    await assert.rejects(
      unavailable.execute({ ...BASE_REQUEST, route } as never, async () => {}),
      (error) =>
        error instanceof TelegramControlError && error.code === "authorization_unavailable",
      `route "${kind}" must fail closed when authorization cannot be checked`,
    );
    assert.equal(featureReached, false, `route "${kind}" ran despite authorization failing`);
  }
});
